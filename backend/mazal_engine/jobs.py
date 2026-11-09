from __future__ import annotations

import json
import multiprocessing
import os
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from .models import EngineRequest
from .services.calculations import background_calculation, run_background


def _write(path: Path, data: dict[str, Any]) -> None:
    temporary = path.with_suffix(".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        json.dump(data, stream, allow_nan=False, separators=(",", ":"))
    temporary.replace(path)


def execute_job(input_path: str, output_path: str) -> None:
    request = EngineRequest.model_validate_json(Path(input_path).read_text())
    try:
        result = run_background(request)
        _write(Path(output_path), {"status": "completed", "result": result, "error": None})
    except Exception as error:
        _write(Path(output_path), {"status": "failed", "error": str(error)[:1000], "result": None})


class JobLimitError(Exception):
    pass


class JobStorageError(Exception):
    pass


class JobManager:
    def __init__(self, directory: Path, maximum_active: int = 2, timeout_seconds: int = 300) -> None:
        self.directory = directory
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.maximum_active = maximum_active
        self.timeout_seconds = timeout_seconds
        self.processes: dict[str, tuple[Any, float]] = {}
        self._records: dict[str, dict[str, Any]] = {}
        self._lock = threading.RLock()
        # A previous server cannot leave an apparently running job after a restart.
        for path in self.directory.glob("*/status.json"):
            try:
                record = json.loads(path.read_text())
            except (OSError, ValueError):
                # One damaged calculation cache must not prevent fresh calculations.
                continue
            if isinstance(record, dict) and record.get("status") in ("running", "queued"):
                record.update(status="failed", error="The engine stopped before this run completed.", progress=None)
                try:
                    _write(path, record)
                except OSError:
                    # Reading the run also detects an absent worker if its cache cannot be updated.
                    continue

    def _path(self, job_id: str) -> Path:
        if str(uuid.UUID(job_id)) != job_id:
            raise ValueError("Invalid run identifier.")
        return self.directory / job_id

    def _stop_worker(self, job_id: str) -> None:
        active = self.processes.pop(job_id, None)
        if active is None:
            return
        process, _started = active
        if process.is_alive():
            process.terminate()
            process.join(timeout=2)
            if process.is_alive():
                process.kill()
                process.join(timeout=2)
        else:
            process.join(timeout=0.1)
        process.close()

    def _save_record(self, job_id: str, record: dict[str, Any]) -> None:
        try:
            _write(self._path(job_id) / "status.json", record)
        except OSError:
            self._stop_worker(job_id)
            self._records[job_id] = {
                **record, "status": "failed", "result": None, "progress": None,
                "error": "The calculation cache could not be saved. Check available disk space and run it again.",
            }
        else:
            if job_id in self.processes:
                self._records[job_id] = record
            else:
                self._records.pop(job_id, None)

    def _refresh(self, job_id: str) -> None:
        active = self.processes.get(job_id)
        if not active:
            return
        process, started = active
        path = self._path(job_id)
        output = path / "output.json"
        try:
            output_text = output.read_text()
        except FileNotFoundError:
            output_text = None
        except (OSError, UnicodeError):
            output_text = ""
        if output_text is not None:
            record = dict(self._records[job_id])
            try:
                result = json.loads(output_text)
                if (
                    not isinstance(result, dict)
                    or result.get("status") not in ("completed", "failed")
                    or result.get("status") == "completed" and not isinstance(result.get("result"), dict)
                    or result.get("status") == "failed" and not isinstance(result.get("error"), str)
                ):
                    raise ValueError("Invalid worker output.")
                json.dumps(result, allow_nan=False)
                record.update(
                    status=result["status"],
                    result=result.get("result") if result["status"] == "completed" else None,
                    error=result.get("error") if result["status"] == "failed" else None,
                    progress=None,
                )
            except (OSError, ValueError):
                record.update(
                    status="failed", result=None,
                    error="The calculation result could not be read. Run the calculation again.", progress=None,
                )
            process.join(timeout=0.1)
            if process.is_alive() and (
                record["status"] == "failed" or time.monotonic() - started > self.timeout_seconds
            ):
                self._stop_worker(job_id)
            elif not process.is_alive():
                self._stop_worker(job_id)
            self._save_record(job_id, record)
        elif not process.is_alive() or time.monotonic() - started > self.timeout_seconds:
            record = dict(self._records[job_id])
            record.update(status="failed", error="The calculation stopped or exceeded its time limit.", progress=None)
            self._stop_worker(job_id)
            self._save_record(job_id, record)

    def reap(self) -> None:
        with self._lock:
            for job_id in list(self.processes):
                self._refresh(job_id)

    def submit(self, request: EngineRequest) -> dict[str, Any]:
        with self._lock:
            return self._submit(request)

    def _submit(self, request: EngineRequest) -> dict[str, Any]:
        calculation = background_calculation(request.kind)
        for job_id in list(self.processes):
            self._refresh(job_id)
        if len(self.processes) >= self.maximum_active:
            raise JobLimitError("Two calculations are already running. Cancel one or wait for it to finish.")
        job_id = str(uuid.uuid4())
        path = self._path(job_id)
        record = {
            "id": job_id, "workspace": request.snapshot.workspace, "status": "running",
            "progress": calculation.progress,
            "result": None, "error": None,
        }
        try:
            path.mkdir(mode=0o700)
        except OSError as error:
            raise JobStorageError("The calculation cache is unavailable. Check available disk space and retry.") from error
        try:
            _write(path / "input.json", request.model_dump())
            _write(path / "status.json", record)
        except OSError as error:
            # No worker or accepted run exists yet; retain completed and accepted runs for reproduction.
            shutil.rmtree(path, ignore_errors=True)
            raise JobStorageError("The calculation cache could not be saved. Check available disk space and retry.") from error
        process = multiprocessing.get_context("spawn").Process(
            target=execute_job, args=(str(path / "input.json"), str(path / "output.json")), daemon=True
        )
        try:
            process.start()
        except Exception:
            record.update(status="failed", error="The calculation worker could not start.", progress=None)
            _write(path / "status.json", record)
            raise
        self.processes[job_id] = (process, time.monotonic())
        self._records[job_id] = record
        return dict(record)

    def get(self, job_id: str, workspace: str) -> dict[str, Any]:
        with self._lock:
            return self._get(job_id, workspace)

    def _get(self, job_id: str, workspace: str) -> dict[str, Any]:
        path = self._path(job_id) / "status.json"
        record = self._records.get(job_id)
        if record is None:
            record = json.loads(path.read_text())
            if (
                not isinstance(record, dict) or record.get("id") != job_id
                or record.get("workspace") not in ("live", "demo")
                or record.get("status") not in ("running", "queued", "completed", "failed", "cancelled")
            ):
                raise ValueError("Invalid cached run.")
        if record["workspace"] != workspace:
            raise FileNotFoundError("Run not found in this workspace.")
        if job_id not in self.processes and record["status"] in ("running", "queued"):
            record.update(status="failed", error="The engine stopped before this run completed.", progress=None)
            self._save_record(job_id, record)
        self._refresh(job_id)
        return dict(self._records[job_id]) if job_id in self._records else json.loads(path.read_text())

    def cancel(self, job_id: str, workspace: str) -> dict[str, Any]:
        with self._lock:
            return self._cancel(job_id, workspace)

    def _cancel(self, job_id: str, workspace: str) -> dict[str, Any]:
        record = self.get(job_id, workspace)
        if record["status"] in ("completed", "cancelled", "failed"):
            return record
        self._stop_worker(job_id)
        record.update(status="cancelled", progress=None, result=None, error=None)
        self._save_record(job_id, record)
        return dict(self._records.get(job_id, record))

    def close(self) -> None:
        with self._lock:
            for job_id in list(self.processes):
                record = self._records[job_id]
                self.cancel(job_id, record["workspace"])
            # A worker may have written its result but still be exiting.
            for job_id in list(self.processes):
                self._stop_worker(job_id)
            self._records.clear()

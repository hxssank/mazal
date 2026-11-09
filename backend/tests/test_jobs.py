import json
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from mazal_engine.jobs import JobLimitError, JobManager, JobStorageError, _write
from mazal_engine.models import EngineRequest


class Worker:
    def __init__(self, **_kwargs):
        self.alive = False
        self.closed = False

    def start(self):
        self.alive = True

    def is_alive(self):
        return self.alive

    def join(self, timeout):
        pass

    def terminate(self):
        self.alive = False

    def kill(self):
        self.alive = False

    def close(self):
        assert not self.alive
        self.closed = True


@pytest.fixture
def manager(tmp_path, monkeypatch):
    class Context:
        Process = Worker

    monkeypatch.setattr("mazal_engine.jobs.multiprocessing.get_context", lambda _method: Context())
    instance = JobManager(tmp_path, maximum_active=2, timeout_seconds=1)
    yield instance
    instance.close()


def request():
    return EngineRequest.model_validate({
        "snapshot": {"workspace": "demo", "revision": 1, "entities": [], "accounts": [],
                     "transactions": [], "obligations": [], "reserves": [], "positions": []},
        "scope": "all", "asOf": "2026-09-26", "kind": "comparison",
    })


def test_simultaneous_submissions_cannot_exceed_worker_limit(manager):
    def submit(_index):
        try:
            return manager.submit(request())["id"]
        except JobLimitError:
            return None

    with ThreadPoolExecutor(max_workers=8) as executor:
        submitted = list(executor.map(submit, range(8)))
    assert len([value for value in submitted if value]) == 2
    assert len(manager.processes) == 2


def test_reaper_stops_expired_worker_without_client_polling(manager):
    job = manager.submit(request())
    worker, _started = manager.processes[job["id"]]
    manager.processes[job["id"]] = worker, time.monotonic() - 2
    manager.reap()
    assert worker.closed
    assert not manager.processes
    status = json.loads((manager.directory / job["id"] / "status.json").read_text())
    assert status["status"] == "failed"
    assert "time limit" in status["error"]


def test_shutdown_reaps_worker_that_wrote_output_before_exiting(manager):
    job = manager.submit(request())
    worker, _started = manager.processes[job["id"]]
    _write(manager.directory / job["id"] / "output.json", {"status": "completed", "result": {}, "error": None})
    manager.close()
    assert worker.closed
    assert not manager.processes
    assert manager.get(job["id"], "demo")["status"] == "completed"


def test_restart_does_not_leave_pending_jobs_running(tmp_path):
    folder = tmp_path / "old-run"
    folder.mkdir()
    _write(folder / "status.json", {"status": "running", "workspace": "demo"})
    JobManager(tmp_path)
    record = json.loads((folder / "status.json").read_text())
    assert record["status"] == "failed"
    assert "engine stopped" in record["error"]


def test_cancel_checks_workspace_before_stopping_worker(manager):
    job = manager.submit(request())
    worker, _started = manager.processes[job["id"]]
    with pytest.raises(FileNotFoundError):
        manager.cancel(job["id"], "live")
    assert worker.alive
    assert manager.cancel(job["id"], "demo")["status"] == "cancelled"
    assert worker.closed
    assert manager.cancel(job["id"], "demo")["status"] == "cancelled"


def test_reaper_stops_worker_stuck_after_publishing_result(manager):
    job = manager.submit(request())
    worker, _started = manager.processes[job["id"]]
    _write(manager.directory / job["id"] / "output.json", {"status": "completed", "result": {"value": 1}, "error": None})
    manager.processes[job["id"]] = worker, time.monotonic() - 2
    manager.reap()
    assert worker.closed
    assert not manager.processes
    record = manager.get(job["id"], "demo")
    assert record["status"] == "completed"
    assert record["result"] == {"value": 1}
    assert manager.submit(request())["status"] == "running"


@pytest.mark.parametrize("contents", ['{"status":', '[]', '{}', 'null'])
def test_damaged_cached_status_does_not_prevent_engine_restart(tmp_path, contents):
    damaged = tmp_path / "damaged"
    damaged.mkdir()
    (damaged / "status.json").write_text(contents)
    pending = tmp_path / "pending"
    pending.mkdir()
    _write(pending / "status.json", {"status": "running", "workspace": "demo"})
    manager = JobManager(tmp_path)
    assert json.loads((pending / "status.json").read_text())["status"] == "failed"
    assert (damaged / "status.json").read_text() == contents
    manager.close()


@pytest.mark.parametrize("contents", [
    '{"status":', '[]', '{}', 'null', '{"status":"running"}',
    '{"status":"completed","result":{"value":NaN}}',
])
def test_damaged_output_fails_only_its_worker_and_releases_capacity(manager, contents):
    damaged = manager.submit(request())
    healthy = manager.submit(request())
    worker, _started = manager.processes[damaged["id"]]
    healthy_worker, _started = manager.processes[healthy["id"]]
    (manager.directory / damaged["id"] / "output.json").write_text(contents)
    manager.reap()
    assert worker.closed
    assert healthy_worker.alive
    failed = manager.get(damaged["id"], "demo")
    assert failed["status"] == "failed"
    assert failed["result"] is None
    assert "could not be read" in failed["error"]
    assert manager.submit(request())["status"] == "running"


@pytest.mark.parametrize("operation", ["cancel", "timeout", "close", "complete"])
def test_damaged_active_status_cannot_hide_or_orphan_worker(manager, operation):
    job = manager.submit(request())
    identifier = job["id"]
    worker, _started = manager.processes[identifier]
    (manager.directory / identifier / "status.json").write_text('{"status":')
    assert manager.get(identifier, "demo")["status"] == "running"
    with pytest.raises(FileNotFoundError):
        manager.get(identifier, "live")
    if operation == "cancel":
        manager.cancel(identifier, "demo")
    elif operation == "close":
        manager.close()
    else:
        if operation == "complete":
            _write(manager.directory / identifier / "output.json", {
                "status": "completed", "result": {"value": 1}, "error": None,
            })
        manager.processes[identifier] = worker, time.monotonic() - 2
        manager.reap()
    assert worker.closed
    assert not manager.processes
    assert manager.get(identifier, "demo")["status"] == {
        "cancel": "cancelled", "close": "cancelled", "timeout": "failed", "complete": "completed",
    }[operation]


def test_worker_output_cannot_replace_workspace_or_run_identity(manager):
    job = manager.submit(request())
    identifier = job["id"]
    worker, _started = manager.processes[identifier]
    _write(manager.directory / identifier / "output.json", {
        "status": "completed", "result": {}, "error": None, "workspace": "live", "id": "wrong",
    })
    manager.processes[identifier] = worker, time.monotonic() - 2
    manager.reap()
    assert manager.get(identifier, "demo")["id"] == identifier
    with pytest.raises(FileNotFoundError):
        manager.get(identifier, "live")


@pytest.mark.parametrize("operation", ["cancel", "timeout", "close", "complete"])
def test_cache_write_failure_cannot_orphan_worker_or_stop_other_runs(manager, monkeypatch, operation):
    damaged = manager.submit(request())
    healthy = manager.submit(request())
    identifier = damaged["id"]
    worker, _started = manager.processes[identifier]
    healthy_worker, _started = manager.processes[healthy["id"]]
    original_write = _write

    def fail_one_status(path, data):
        if path == manager.directory / identifier / "status.json":
            raise OSError("Synthetic disk write failure")
        original_write(path, data)

    monkeypatch.setattr("mazal_engine.jobs._write", fail_one_status)
    if operation == "cancel":
        result = manager.cancel(identifier, "demo")
        assert result["status"] == "failed"
    elif operation == "close":
        manager.close()
    else:
        if operation == "complete":
            _write(manager.directory / identifier / "output.json", {
                "status": "completed", "result": {}, "error": None,
            })
        manager.processes[identifier] = worker, time.monotonic() - 2
        manager.reap()
    assert worker.closed
    assert identifier not in manager.processes
    if operation != "close":
        assert healthy_worker.alive
        record = manager.get(identifier, "demo")
        assert record["status"] == "failed"
        assert record["result"] is None
        assert "cache could not be saved" in record["error"]
        manager.cancel(healthy["id"], "demo")
        assert healthy_worker.closed
    else:
        assert healthy_worker.closed


def test_readonly_pending_cache_is_failed_after_restart(tmp_path, monkeypatch):
    import uuid

    identifier = str(uuid.uuid4())
    folder = tmp_path / identifier
    folder.mkdir()
    _write(folder / "status.json", {"id": identifier, "status": "running", "workspace": "demo"})

    def fail_write(_path, _data):
        raise OSError("Synthetic readonly cache")

    monkeypatch.setattr("mazal_engine.jobs._write", fail_write)
    manager = JobManager(tmp_path)
    assert manager.get(identifier, "demo")["status"] == "failed"
    assert not manager.processes
    manager.close()


@pytest.mark.parametrize("filename", ["input.json", "status.json"])
def test_failed_admission_does_not_spawn_or_leave_partial_snapshot(manager, monkeypatch, filename):
    accepted = manager.submit(request())
    accepted_folder = manager.directory / accepted["id"]
    original_write = _write

    def fail_new_run(path, data):
        if path.parent != accepted_folder and path.name == filename:
            raise OSError("Synthetic disk write failure")
        original_write(path, data)

    monkeypatch.setattr("mazal_engine.jobs._write", fail_new_run)
    for _attempt in range(3):
        with pytest.raises(JobStorageError, match="cache could not be saved"):
            manager.submit(request())
        assert list(manager.directory.iterdir()) == [accepted_folder]
        assert list(manager.processes) == [accepted["id"]]


def test_existing_completed_runs_are_retained_for_reproduction(manager):
    job = manager.submit(request())
    identifier = job["id"]
    original_input = (manager.directory / identifier / "input.json").read_bytes()
    worker, _started = manager.processes[identifier]
    _write(manager.directory / identifier / "output.json", {
        "status": "completed", "result": {"answer": 42}, "error": None,
    })
    manager.processes[identifier] = worker, time.monotonic() - 2
    manager.reap()
    manager.close()
    restarted = JobManager(manager.directory)
    assert restarted.get(identifier, "demo")["result"] == {"answer": 42}
    assert (manager.directory / identifier / "input.json").read_bytes() == original_input
    restarted.close()


@pytest.mark.parametrize("error", [OSError("Synthetic read failure"), UnicodeError("Invalid encoding")])
def test_unreadable_worker_output_cannot_stop_reaper(manager, monkeypatch, error):
    job = manager.submit(request())
    worker, _started = manager.processes[job["id"]]
    original_read = Path.read_text

    def unreadable_output(path, *args, **kwargs):
        if path == manager.directory / job["id"] / "output.json":
            raise error
        return original_read(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", unreadable_output)
    manager.reap()
    assert worker.closed
    assert manager.get(job["id"], "demo")["status"] == "failed"
    assert manager.submit(request())["status"] == "running"

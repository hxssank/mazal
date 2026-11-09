from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
import uuid
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, BinaryIO

if TYPE_CHECKING:
    from .jobs import JobManager

MAX_ARCHIVE_BYTES = 128 * 1024 * 1024
MAX_FILES_PER_RUN = 32
MAX_RUNS_PER_ARCHIVE = 20
TERMINAL = {"completed", "failed", "cancelled"}
FILE_NAME = re.compile(r"[A-Za-z0-9_.-]{1,100}\Z")


class StorageConflict(ValueError):
    pass


def _identifier(value: str) -> str:
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError("Choose a valid calculation or archive identifier.")
    return value


def _workspace(value: str) -> str:
    if value not in ("live", "demo"):
        raise ValueError("Choose the live or demo workspace.")
    return value


def _regular(path: Path) -> os.stat_result:
    result = path.lstat()
    if not stat.S_ISREG(result.st_mode):
        raise ValueError("Calculation evidence must contain regular files, without symbolic links.")
    return result


def _directory(path: Path) -> None:
    if not stat.S_ISDIR(path.lstat().st_mode):
        raise ValueError("Calculation storage must use directories, without symbolic links.")


def _open(path: Path) -> BinaryIO:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    if not stat.S_ISREG(os.fstat(descriptor).st_mode):
        os.close(descriptor)
        raise ValueError("Calculation evidence must contain regular files.")
    return os.fdopen(descriptor, "rb")


def _hash_file(path: Path, maximum: int = MAX_ARCHIVE_BYTES) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    _regular(path)
    with _open(path) as stream:
        while chunk := stream.read(1024 * 1024):
            size += len(chunk)
            if size > maximum:
                raise ValueError("Select calculations containing at most 128 MB of evidence per archive.")
            digest.update(chunk)
    return size, digest.hexdigest()


def _copy_evidence(source: BinaryIO, destination: BinaryIO, expected_size: int) -> None:
    copied = 0
    while chunk := source.read(min(1024 * 1024, expected_size - copied + 1)):
        copied += len(chunk)
        if copied > expected_size:
            raise StorageConflict("Calculation evidence changed size while copying. Original evidence was kept.")
        destination.write(chunk)
    if copied != expected_size:
        raise StorageConflict("Calculation evidence changed size while copying. Original evidence was kept.")


def _json_file(path: Path, maximum: int = MAX_ARCHIVE_BYTES) -> dict[str, Any]:
    if _regular(path).st_size > maximum:
        raise ValueError("The calculation metadata exceeds its supported size.")
    with _open(path) as stream:
        raw = stream.read(maximum + 1)
    if len(raw) > maximum:
        raise ValueError("The calculation metadata exceeds its supported size.")
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("The calculation metadata is unreadable.")
    return value


def _sync_directory(path: Path) -> None:
    if os.name != "nt":
        descriptor = os.open(path, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def _write_json(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_name(f".{path.stem}.{uuid.uuid4()}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w") as stream:
            json.dump(value, stream, allow_nan=False, sort_keys=True, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
        _sync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


class CalculationStorage:
    def __init__(self, manager: JobManager) -> None:
        self.manager = manager
        self.directory = manager.directory
        self.archives = self.directory.parent / f"{self.directory.name}-archives"
        self.archives.mkdir(mode=0o700, exist_ok=True)
        _directory(self.directory)
        _directory(self.archives)
        self._recover_archive_metadata()
        self._recover_interrupted_moves()

    def _recover_archive_metadata(self) -> None:
        for path in self.archives.glob("*.zip"):
            try:
                identifier = _identifier(path.stem)
                metadata_path = self.archives / f"{identifier}.json"
                if metadata_path.exists() or metadata_path.is_symlink():
                    continue
                with _open(path) as source, zipfile.ZipFile(source) as archive:
                    if archive.getinfo("manifest.json").file_size > 1024 * 1024:
                        continue
                    candidate = json.loads(archive.read("manifest.json"))
                manifest = self._verify(path, _workspace(candidate["workspace"]), identifier)
                size, digest = _hash_file(path, MAX_ARCHIVE_BYTES + 1024 * 1024)
                _write_json(metadata_path, {
                    "format": manifest["format"], "version": 1, "id": identifier,
                    "workspace": manifest["workspace"], "createdAt": manifest["createdAt"],
                    "runIds": [run["id"] for run in manifest["runs"]], "runCount": len(manifest["runs"]),
                    "bytes": size, "uncompressedBytes": sum(item["size"] for item in manifest["files"]),
                    "sha256": digest,
                })
            except (OSError, ValueError, TypeError, KeyError, zipfile.BadZipFile):
                continue

    def _unclassified_size(self, path: Path) -> int:
        information = path.lstat()
        if not stat.S_ISDIR(information.st_mode):
            return information.st_size
        return sum(self._unclassified_size(child) for child in path.iterdir())

    def _recover_interrupted_moves(self) -> None:
        for staging in self.archives.glob(".moving-*"):
            try:
                _directory(staging)
                identifier = _identifier(staging.name.removeprefix(".moving-"))
                metadata = _json_file(self.archives / f"{identifier}.json", 1024 * 1024)
                _path, manifest = self.verified_archive(metadata["workspace"], identifier)
                allowed = {run["id"] for run in manifest["runs"]}
                for folder in staging.iterdir():
                    if folder.name not in allowed:
                        continue
                    destination = self.directory / folder.name
                    if not destination.exists() and not destination.is_symlink() and self._matches(folder, folder.name, manifest):
                        folder.rename(destination)
                _sync_directory(self.directory)
                if not any(staging.iterdir()):
                    staging.rmdir()
                _sync_directory(self.archives)
            except (OSError, ValueError, TypeError, KeyError, zipfile.BadZipFile):
                # Evidence left by an interrupted move remains visible in archive storage usage.
                continue

    def _retained_bytes(self, folder: Path) -> int:
        if not folder.exists() and not folder.is_symlink():
            return 0
        _directory(folder)
        total = 0
        for run in folder.iterdir():
            _directory(run)
            for path in run.iterdir():
                total += _regular(path).st_size
        return total

    def _files(self, folder: Path) -> list[Path]:
        _directory(folder)
        files = sorted(folder.iterdir())
        if len(files) > MAX_FILES_PER_RUN:
            raise ValueError("A calculation contains too many evidence files to archive.")
        for path in files:
            if not FILE_NAME.fullmatch(path.name) or path.name in (".", ".."):
                raise ValueError("A calculation contains an unsupported evidence filename.")
            _regular(path)
        if not {"input.json", "status.json"} <= {path.name for path in files}:
            raise ValueError("A calculation is missing its original input or status evidence.")
        return files

    def _run(self, identifier: str, workspace: str) -> dict[str, Any]:
        folder = self.directory / _identifier(identifier)
        files = self._files(folder)
        source = _json_file(folder / "input.json")
        if not isinstance(source.get("snapshot"), dict) or source["snapshot"].get("workspace") != workspace:
            raise FileNotFoundError("Calculation not found in this workspace.")
        record = self.manager.get(identifier, workspace)
        return {
            "id": identifier, "workspace": workspace, "status": record["status"],
            "kind": source.get("kind", "comparison"), "revision": source["snapshot"].get("revision"),
            "scope": source.get("scope"), "asOf": source.get("asOf"),
            "createdAt": datetime.fromtimestamp((folder / "input.json").stat().st_mtime, UTC).isoformat(),
            "bytes": sum(_regular(path).st_size for path in files),
            "fileCount": len(files),
            "archivable": record["status"] in TERMINAL and identifier not in self.manager.processes,
        }

    def _metadata(self, identifier: str, workspace: str) -> dict[str, Any]:
        identifier = _identifier(identifier)
        metadata = _json_file(self.archives / f"{identifier}.json", 1024 * 1024)
        if metadata.get("workspace") != workspace:
            raise FileNotFoundError("Archive not found in this workspace.")
        if (
            metadata.get("id") != identifier or metadata.get("format") != "mazal-calculation-archive"
            or metadata.get("version") != 1 or not isinstance(metadata.get("runIds"), list)
            or not 1 <= len(metadata["runIds"]) <= MAX_RUNS_PER_ARCHIVE
            or any(not isinstance(value, str) for value in metadata["runIds"])
            or len(set(metadata["runIds"])) != len(metadata["runIds"])
            or not isinstance(metadata.get("sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", metadata["sha256"])
            or not isinstance(metadata.get("bytes"), int) or metadata["bytes"] < 0
            or not isinstance(metadata.get("uncompressedBytes"), int) or metadata["uncompressedBytes"] < 0
            or metadata.get("runCount") != len(metadata["runIds"])
            or not isinstance(metadata.get("createdAt"), str)
        ):
            raise ValueError("The archive metadata is unreadable.")
        for run_id in metadata["runIds"]:
            _identifier(run_id)
        _regular(self.archives / f"{identifier}.zip")
        return metadata

    def list(self, workspace: str) -> dict[str, Any]:
        workspace = _workspace(workspace)
        with self.manager._lock:
            _directory(self.directory)
            _directory(self.archives)
            self.manager.reap()
            runs = []
            archives = []
            unreadable = 0
            unclassified = 0
            for folder in self.directory.iterdir():
                if folder.name.startswith("."):
                    unreadable += 1
                    unclassified += self._unclassified_size(folder)
                    continue
                try:
                    runs.append(self._run(folder.name, workspace))
                except FileNotFoundError:
                    continue
                except (OSError, ValueError, TypeError, KeyError):
                    unreadable += 1
                    try:
                        unclassified += self._unclassified_size(folder)
                    except OSError:
                        pass
            for path in self.archives.glob("*.json"):
                try:
                    metadata = self._metadata(path.stem, workspace)
                    metadata = {**metadata, "bytes": _regular(self.archives / f"{path.stem}.zip").st_size}
                    metadata["metadataBytes"] = _regular(path).st_size
                    metadata["retainedBytes"] = self._retained_bytes(self.archives / f".moving-{path.stem}")
                    metadata["restoredRunCount"] = sum(
                        any(run["id"] == identifier for run in runs) for identifier in metadata["runIds"]
                    )
                    archives.append(metadata)
                except FileNotFoundError:
                    continue
                except (OSError, ValueError, TypeError, KeyError):
                    unreadable += 1
            for path in self.archives.iterdir():
                if path.suffix == ".json" or path.suffix == ".zip" and path.with_suffix(".json").exists():
                    continue
                if path.name.startswith(".moving-") and (self.archives / f"{path.name.removeprefix('.moving-')}.json").exists():
                    continue
                unreadable += 1
                try:
                    unclassified += self._unclassified_size(path)
                except OSError:
                    pass
            run_bytes = sum(run["bytes"] for run in runs)
            archive_bytes = sum(archive["bytes"] + archive["metadataBytes"] + archive["retainedBytes"] for archive in archives)
            return {
                "workspace": workspace, "runBytes": run_bytes, "archiveBytes": archive_bytes,
                "totalBytes": run_bytes + archive_bytes,
                "runs": sorted(runs, key=lambda item: item["createdAt"], reverse=True),
                "archives": sorted(archives, key=lambda item: item["createdAt"], reverse=True),
                "unreadableEntryCount": unreadable,
                "unclassifiedBytes": unclassified,
                "limits": {"runsPerArchive": MAX_RUNS_PER_ARCHIVE, "uncompressedBytesPerArchive": MAX_ARCHIVE_BYTES},
            }

    def _verify(self, path: Path, workspace: str, identifier: str) -> dict[str, Any]:
        if _regular(path).st_size > MAX_ARCHIVE_BYTES + 1024 * 1024:
            raise ValueError("The archive exceeds its supported size.")
        with _open(path) as source, zipfile.ZipFile(source) as archive:
            entries = archive.infolist()
            names = [entry.filename for entry in entries]
            if len(names) != len(set(names)) or len(names) > MAX_RUNS_PER_ARCHIVE * MAX_FILES_PER_RUN + 1:
                raise ValueError("The archive contains duplicate or excessive entries.")
            if "manifest.json" not in names or archive.getinfo("manifest.json").file_size > 1024 * 1024:
                raise ValueError("The archive manifest is missing or too large.")
            manifest = json.loads(archive.read("manifest.json"))
            if (
                not isinstance(manifest, dict) or manifest.get("format") != "mazal-calculation-archive"
                or manifest.get("version") != 1 or manifest.get("id") != identifier
                or manifest.get("workspace") != workspace or not isinstance(manifest.get("runs"), list)
                or not 1 <= len(manifest["runs"]) <= MAX_RUNS_PER_ARCHIVE
                or not isinstance(manifest.get("files"), list)
                or any(not isinstance(item, dict) or not isinstance(item.get("id"), str) for item in manifest["runs"])
                or any(not isinstance(item, dict) or not isinstance(item.get("path"), str) for item in manifest["files"])
            ):
                raise ValueError("The archive manifest does not match this workspace and archive.")
            run_ids = [item["id"] for item in manifest["runs"]]
            if len(set(run_ids)) != len(run_ids):
                raise ValueError("The archive repeats a calculation.")
            for run_id in run_ids:
                _identifier(run_id)
            expected = {item["path"] for item in manifest["files"]}
            if len(expected) != len(manifest["files"]) or set(names) != expected | {"manifest.json"}:
                raise ValueError("The archive entries do not match its manifest.")
            total = 0
            for item in manifest["files"]:
                parts = item["path"].split("/")
                if (
                    len(parts) != 3 or parts[0] != "runs" or parts[1] not in run_ids
                    or not FILE_NAME.fullmatch(parts[2]) or parts[2] in (".", "..")
                    or not isinstance(item.get("size"), int) or not 0 <= item["size"] <= MAX_ARCHIVE_BYTES
                    or not isinstance(item.get("sha256"), str)
                ):
                    raise ValueError("The archive contains an unsafe evidence entry.")
                entry = archive.getinfo(item["path"])
                mode = entry.external_attr >> 16
                if stat.S_IFMT(mode) not in (0, stat.S_IFREG) or entry.is_dir() or entry.file_size != item["size"]:
                    raise ValueError("The archive contains unsupported evidence entries.")
                total += entry.file_size
                if total > MAX_ARCHIVE_BYTES:
                    raise ValueError("The archive expands beyond 128 MB.")
                digest = hashlib.sha256()
                size = 0
                with archive.open(entry) as stream:
                    while chunk := stream.read(1024 * 1024):
                        size += len(chunk)
                        if size > item["size"]:
                            raise ValueError("An archive entry exceeds its recorded size.")
                        digest.update(chunk)
                if size != item["size"] or digest.hexdigest() != item["sha256"]:
                    raise ValueError("An archive evidence hash does not match its manifest.")
            for run_id in run_ids:
                if not {f"runs/{run_id}/input.json", f"runs/{run_id}/status.json"} <= expected:
                    raise ValueError("The archive is missing a calculation's original input or status.")
                original = json.loads(archive.read(f"runs/{run_id}/input.json"))
                status = json.loads(archive.read(f"runs/{run_id}/status.json"))
                if (
                    not isinstance(original, dict) or not isinstance(original.get("snapshot"), dict)
                    or not isinstance(status, dict) or original["snapshot"].get("workspace") != workspace
                    or status.get("workspace") != workspace or status.get("id") != run_id
                    or status.get("status") not in TERMINAL
                ):
                    raise ValueError("The archive includes an active calculation or another workspace.")
            return manifest

    def _matches(self, folder: Path, run_id: str, manifest: dict[str, Any]) -> bool:
        expected = {Path(item["path"]).name: item for item in manifest["files"] if item["path"].split("/")[1] == run_id}
        files = self._files(folder)
        return {path.name for path in files} == set(expected) and all(
            _hash_file(path) == (expected[path.name]["size"], expected[path.name]["sha256"]) for path in files
        )

    def archive(self, workspace: str, run_ids: list[str]) -> dict[str, Any]:
        workspace = _workspace(workspace)
        if (
            not isinstance(run_ids, list) or not 1 <= len(run_ids) <= MAX_RUNS_PER_ARCHIVE
            or any(not isinstance(value, str) for value in run_ids) or len(set(run_ids)) != len(run_ids)
        ):
            raise ValueError("Select between 1 and 20 distinct finished calculations.")
        with self.manager._lock:
            _directory(self.directory)
            _directory(self.archives)
            if any(identifier in self.manager.processes for identifier in run_ids):
                raise StorageConflict("Wait for every selected calculation to finish before archiving it.")
            runs = [self._run(identifier, workspace) for identifier in run_ids]
            if any(not run["archivable"] for run in runs):
                raise StorageConflict("Wait for every selected calculation to finish before archiving it.")
            if sum(run["bytes"] for run in runs) > MAX_ARCHIVE_BYTES:
                raise ValueError("Select calculations containing at most 128 MB of evidence per archive.")
            identifier = str(uuid.uuid4())
            temporary = self.archives / f".{identifier}.tmp"
            destination = self.archives / f"{identifier}.zip"
            staging = self.archives / f".moving-{identifier}"
            manifest = {
                "format": "mazal-calculation-archive", "version": 1, "id": identifier, "workspace": workspace,
                "createdAt": datetime.now(UTC).isoformat(), "runs": runs, "files": [],
            }
            try:
                descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(descriptor, "wb") as target:
                    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                        for run_id in run_ids:
                            for path in self._files(self.directory / run_id):
                                size, digest = _hash_file(path)
                                name = f"runs/{run_id}/{path.name}"
                                with _open(path) as source, archive.open(name, "w") as output:
                                    _copy_evidence(source, output, size)
                                manifest["files"].append({"path": name, "size": size, "sha256": digest})
                        archive.writestr("manifest.json", json.dumps(manifest, allow_nan=False, sort_keys=True))
                    target.flush()
                    os.fsync(target.fileno())
                self._verify(temporary, workspace, identifier)
                if any(not self._matches(self.directory / run_id, run_id, manifest) for run_id in run_ids):
                    raise StorageConflict("Calculation evidence changed while archiving. Original files were kept.")
                temporary.replace(destination)
                _sync_directory(self.archives)
                size, digest = _hash_file(destination, MAX_ARCHIVE_BYTES + 1024 * 1024)
                metadata = {
                    "format": manifest["format"], "version": 1, "id": identifier, "workspace": workspace,
                    "createdAt": manifest["createdAt"], "runIds": run_ids, "runCount": len(run_ids),
                    "bytes": size, "uncompressedBytes": sum(item["size"] for item in manifest["files"]),
                    "sha256": digest,
                }
                _write_json(self.archives / f"{identifier}.json", metadata)
                staging.mkdir(mode=0o700)
                try:
                    for run_id in run_ids:
                        (self.directory / run_id).rename(staging / run_id)
                    if any(not self._matches(staging / run_id, run_id, manifest) for run_id in run_ids):
                        raise StorageConflict("Calculation evidence changed while moving. Original files were kept.")
                except Exception:
                    for path in staging.iterdir():
                        if not (self.directory / path.name).exists():
                            path.rename(self.directory / path.name)
                    raise
                _sync_directory(self.directory)
                shutil.rmtree(staging)
                _sync_directory(self.archives)
                return {"workspace": workspace, "archiveId": identifier, "archivedRunCount": len(run_ids)}
            finally:
                temporary.unlink(missing_ok=True)

    def verified_archive(self, workspace: str, identifier: str) -> tuple[Path, dict[str, Any]]:
        workspace = _workspace(workspace)
        with self.manager._lock:
            metadata = self._metadata(identifier, workspace)
            path = self.archives / f"{identifier}.zip"
            size, digest = _hash_file(path, MAX_ARCHIVE_BYTES + 1024 * 1024)
            if size != metadata["bytes"] or digest != metadata["sha256"]:
                raise ValueError("The saved archive hash does not match. No calculation evidence was changed.")
            manifest = self._verify(path, workspace, identifier)
            if metadata["runIds"] != [run["id"] for run in manifest["runs"]]:
                raise ValueError("The saved archive run list does not match its manifest.")
            return path, manifest

    def restore(self, workspace: str, identifier: str) -> dict[str, Any]:
        workspace = _workspace(workspace)
        with self.manager._lock:
            path, manifest = self.verified_archive(workspace, identifier)
            restore_ids = []
            for run in manifest["runs"]:
                run_id = run["id"]
                folder = self.directory / run_id
                if run_id in self.manager.processes:
                    raise StorageConflict("A calculation with this identifier is still active.")
                if folder.exists() or folder.is_symlink():
                    if not self._matches(folder, run_id, manifest):
                        raise StorageConflict("An existing calculation has different evidence. Nothing was overwritten.")
                else:
                    restore_ids.append(run_id)
            staging = self.directory / f".restoring-{uuid.uuid4()}"
            staging.mkdir(mode=0o700)
            try:
                with _open(path) as source, zipfile.ZipFile(source) as archive:
                    for run_id in restore_ids:
                        (staging / run_id).mkdir(mode=0o700)
                        for item in manifest["files"]:
                            if item["path"].split("/")[1] != run_id:
                                continue
                            target = staging / run_id / Path(item["path"]).name
                            descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                            with os.fdopen(descriptor, "wb") as output, archive.open(item["path"]) as evidence:
                                _copy_evidence(evidence, output, item["size"])
                                output.flush()
                                os.fsync(output.fileno())
                        if not self._matches(staging / run_id, run_id, manifest):
                            raise ValueError("Restored evidence failed its hash check. The archive was kept.")
                for run_id in restore_ids:
                    if (self.directory / run_id).exists() or (self.directory / run_id).is_symlink():
                        raise StorageConflict("A calculation appeared during restoration. Nothing was overwritten.")
                    (staging / run_id).rename(self.directory / run_id)
                _sync_directory(self.directory)
                return {"workspace": workspace, "archiveId": identifier, "restoredRunCount": len(restore_ids)}
            finally:
                shutil.rmtree(staging, ignore_errors=True)

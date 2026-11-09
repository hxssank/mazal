from __future__ import annotations

import hashlib
import json
import uuid
import zipfile
from pathlib import Path
from typing import Any

import pytest

from mazal_engine.jobs import JobManager, _write
from mazal_engine.storage import CalculationStorage, StorageConflict


@pytest.fixture
def storage(tmp_path: Path) -> CalculationStorage:
    return CalculationStorage(JobManager(tmp_path / "runs"))


def run(storage: CalculationStorage, workspace: str = "live", status: str = "completed") -> str:
    identifier = str(uuid.uuid4())
    folder = storage.directory / identifier
    folder.mkdir()
    _write(folder / "input.json", {
        "snapshot": {"workspace": workspace, "revision": 123},
        "kind": "comparison", "scope": "personal", "asOf": "2026-09-27",
        "unknown": None, "evidence": "original evidence " * 1000,
    })
    _write(folder / "status.json", {"id": identifier, "workspace": workspace, "status": status, "result": {"cents": 12345}})
    _write(folder / "output.json", {"status": status, "result": {"cents": 12345, "unknown": None}})
    return identifier


def originals(storage: CalculationStorage, identifier: str) -> dict[str, bytes]:
    return {path.name: path.read_bytes() for path in (storage.directory / identifier).iterdir()}


def test_archive_and_restore_preserve_every_original_byte_and_manifest_hash(storage: CalculationStorage) -> None:
    identifier = run(storage)
    (storage.directory / identifier / "output.tmp").write_bytes(b"unfinished original evidence\x00\xff")
    before = originals(storage, identifier)
    response = storage.archive("live", [identifier])
    assert not (storage.directory / identifier).exists()
    listed = storage.list("live")
    archive = listed["archives"][0]
    assert listed["runs"] == []
    assert archive["runIds"] == [identifier]
    assert archive["uncompressedBytes"] == sum(len(data) for data in before.values())
    assert archive["bytes"] < archive["uncompressedBytes"]
    path, manifest = storage.verified_archive("live", response["archiveId"])
    assert hashlib.sha256(path.read_bytes()).hexdigest() == archive["sha256"]
    with zipfile.ZipFile(path) as evidence:
        for item in manifest["files"]:
            data = evidence.read(item["path"])
            assert data == before[Path(item["path"]).name]
            assert len(data) == item["size"]
            assert hashlib.sha256(data).hexdigest() == item["sha256"]
    assert storage.restore("live", archive["id"])["restoredRunCount"] == 1
    assert originals(storage, identifier) == before
    assert path.exists()
    assert storage.restore("live", archive["id"])["restoredRunCount"] == 0
    assert storage.list("live")["archives"][0]["restoredRunCount"] == 1


def test_usage_filters_workspaces_and_reports_exact_uncompressed_file_bytes(storage: CalculationStorage) -> None:
    live = run(storage)
    demo = run(storage, "demo")
    result = storage.list("live")
    assert [item["id"] for item in result["runs"]] == [live]
    assert result["runBytes"] == sum(map(len, originals(storage, live).values()))
    assert result["totalBytes"] == result["runBytes"]
    assert demo not in json.dumps(result)
    assert [item["id"] for item in storage.list("demo")["runs"]] == [demo]


@pytest.mark.parametrize("status", ["completed", "failed", "cancelled"])
def test_every_terminal_status_can_be_archived(storage: CalculationStorage, status: str) -> None:
    identifier = run(storage, status=status)
    archive = storage.archive("live", [identifier])
    assert archive["archivedRunCount"] == 1


def test_running_worker_cannot_be_archived_even_with_completed_status(storage: CalculationStorage) -> None:
    identifier = run(storage)
    storage.manager.processes[identifier] = (object(), 0)
    with pytest.raises(StorageConflict, match="finish"):
        storage.archive("live", [identifier])
    assert (storage.directory / identifier).exists()
    storage.manager.processes.clear()


@pytest.mark.parametrize("selected", [[], ["../outside"], ["bad"], [str(uuid.uuid4())] * 2, [str(uuid.uuid4()) for _ in range(21)]])
def test_invalid_archive_selection_changes_nothing(storage: CalculationStorage, selected: list[str]) -> None:
    identifier = run(storage)
    before = originals(storage, identifier)
    with pytest.raises((ValueError, FileNotFoundError)):
        storage.archive("live", selected)
    assert originals(storage, identifier) == before
    assert list(storage.archives.iterdir()) == []


def test_mixed_workspace_selection_is_rejected_before_archiving(storage: CalculationStorage) -> None:
    live = run(storage)
    demo = run(storage, "demo")
    with pytest.raises(FileNotFoundError):
        storage.archive("live", [live, demo])
    assert (storage.directory / live).exists()
    assert (storage.directory / demo).exists()
    assert list(storage.archives.iterdir()) == []


def test_wrong_workspace_cannot_list_download_or_restore_archive(storage: CalculationStorage) -> None:
    identifier = run(storage)
    archived = storage.archive("live", [identifier])["archiveId"]
    assert storage.list("demo")["archives"] == []
    for action in (storage.verified_archive, storage.restore):
        with pytest.raises(FileNotFoundError):
            action("demo", archived)


def test_failed_archive_verification_preserves_originals(storage: CalculationStorage, monkeypatch: pytest.MonkeyPatch) -> None:
    identifier = run(storage)
    before = originals(storage, identifier)

    def fail(*_args: Any) -> None:
        raise ValueError("Synthetic verification failure")

    monkeypatch.setattr(storage, "_verify", fail)
    with pytest.raises(ValueError, match="verification"):
        storage.archive("live", [identifier])
    assert originals(storage, identifier) == before
    assert list(storage.archives.iterdir()) == []


def test_concurrent_evidence_change_never_removes_originals(storage: CalculationStorage, monkeypatch: pytest.MonkeyPatch) -> None:
    identifier = run(storage)
    verify = storage._verify

    def change_after_verification(*args: Any) -> dict[str, Any]:
        manifest = verify(*args)
        (storage.directory / identifier / "output.json").write_text("new evidence")
        return manifest

    monkeypatch.setattr(storage, "_verify", change_after_verification)
    with pytest.raises(StorageConflict, match="changed"):
        storage.archive("live", [identifier])
    assert (storage.directory / identifier / "output.json").read_text() == "new evidence"


def test_move_failure_rolls_back_original_directories(storage: CalculationStorage, monkeypatch: pytest.MonkeyPatch) -> None:
    first, second = run(storage), run(storage)
    before = {identifier: originals(storage, identifier) for identifier in (first, second)}
    rename = Path.rename

    def fail_second(path: Path, target: Path) -> Path:
        if path == storage.directory / second:
            raise OSError("Synthetic move failure")
        return rename(path, target)

    monkeypatch.setattr(Path, "rename", fail_second)
    with pytest.raises(OSError, match="move failure"):
        storage.archive("live", [first, second])
    for identifier in (first, second):
        assert originals(storage, identifier) == before[identifier]
    assert len(storage.list("live")["archives"]) == 1


def test_restore_collision_preserves_both_archive_and_existing_evidence(storage: CalculationStorage) -> None:
    identifier = run(storage)
    archived = storage.archive("live", [identifier])["archiveId"]
    storage.restore("live", archived)
    existing = storage.directory / identifier / "output.json"
    existing.write_text("different evidence")
    with pytest.raises(StorageConflict, match="different evidence"):
        storage.restore("live", archived)
    assert existing.read_text() == "different evidence"
    assert (storage.archives / f"{archived}.zip").exists()


def test_tampered_archive_cannot_be_downloaded_or_restored(storage: CalculationStorage) -> None:
    identifier = run(storage)
    archived = storage.archive("live", [identifier])["archiveId"]
    path = storage.archives / f"{archived}.zip"
    path.write_bytes(path.read_bytes() + b"tampered")
    for action in (storage.verified_archive, storage.restore):
        with pytest.raises(ValueError, match="hash"):
            action("live", archived)
    assert not (storage.directory / identifier).exists()


@pytest.mark.parametrize("target", ["run", "input", "archive", "metadata"])
def test_symlinks_are_rejected_without_touching_target(storage: CalculationStorage, tmp_path: Path, target: str) -> None:
    identifier = run(storage)
    if target == "run":
        path = storage.directory / identifier
        outside = tmp_path / "outside"
        path.rename(outside)
        path.symlink_to(outside, target_is_directory=True)
        with pytest.raises(ValueError, match="symbolic links"):
            storage.archive("live", [identifier])
        assert (outside / "input.json").exists()
    elif target == "input":
        path = storage.directory / identifier / "input.json"
        outside = tmp_path / "outside.json"
        path.rename(outside)
        path.symlink_to(outside)
        with pytest.raises(ValueError, match="symbolic links"):
            storage.archive("live", [identifier])
        assert outside.exists()
    else:
        archived = storage.archive("live", [identifier])["archiveId"]
        suffix = "zip" if target == "archive" else "json"
        path = storage.archives / f"{archived}.{suffix}"
        outside = tmp_path / f"outside.{suffix}"
        path.rename(outside)
        path.symlink_to(outside)
        with pytest.raises(ValueError, match="symbolic links"):
            storage.restore("live", archived)
        assert outside.exists()


def test_listing_reports_unreadable_evidence_without_deleting_it(storage: CalculationStorage) -> None:
    identifier = run(storage)
    path = storage.directory / identifier / "input.json"
    path.write_text("damaged original")
    assert storage.list("live")["unreadableEntryCount"] == 1
    assert path.read_text() == "damaged original"


def test_archive_limit_fails_before_compression(storage: CalculationStorage, monkeypatch: pytest.MonkeyPatch) -> None:
    identifier = run(storage)
    monkeypatch.setattr("mazal_engine.storage.MAX_ARCHIVE_BYTES", 100)
    with pytest.raises(ValueError):
        storage.archive("live", [identifier])
    assert (storage.directory / identifier).exists()
    assert list(storage.archives.iterdir()) == []


def test_restart_recovers_interrupted_moves_without_deleting_evidence(storage: CalculationStorage) -> None:
    identifier = run(storage)
    before = originals(storage, identifier)
    archived = storage.archive("live", [identifier])["archiveId"]
    storage.restore("live", archived)
    staging = storage.archives / f".moving-{archived}"
    staging.mkdir()
    (storage.directory / identifier).rename(staging / identifier)
    restarted = CalculationStorage(JobManager(storage.directory))
    assert originals(restarted, identifier) == before
    assert not staging.exists()
    assert (restarted.archives / f"{archived}.zip").exists()
    assert restarted.list("live")["archives"][0]["retainedBytes"] == 0


def test_interrupted_move_collision_remains_visible_in_exact_storage_usage(storage: CalculationStorage) -> None:
    import shutil

    identifier = run(storage)
    archived = storage.archive("live", [identifier])["archiveId"]
    storage.restore("live", archived)
    staging = storage.archives / f".moving-{archived}"
    staging.mkdir()
    shutil.copytree(storage.directory / identifier, staging / identifier)
    restarted = CalculationStorage(JobManager(storage.directory))
    listed = restarted.list("live")
    archive = listed["archives"][0]
    retained = sum(path.stat().st_size for path in (staging / identifier).iterdir())
    assert archive["retainedBytes"] == retained
    assert listed["archiveBytes"] == archive["bytes"] + archive["metadataBytes"] + retained
    assert listed["totalBytes"] == listed["archiveBytes"] + listed["runBytes"]
    assert (staging / identifier).exists()


def test_traversal_in_rehashed_archive_is_rejected(storage: CalculationStorage) -> None:
    identifier = run(storage)
    archived = storage.archive("live", [identifier])["archiveId"]
    path = storage.archives / f"{archived}.zip"
    with zipfile.ZipFile(path) as archive:
        contents = {name: archive.read(name) for name in archive.namelist()}
    manifest = json.loads(contents["manifest.json"])
    original = manifest["files"][0]["path"]
    unsafe = f"runs/{identifier}/../outside.json"
    manifest["files"][0]["path"] = unsafe
    contents[unsafe] = contents.pop(original)
    contents["manifest.json"] = json.dumps(manifest).encode()
    with zipfile.ZipFile(path, "w") as archive:
        for name, data in contents.items():
            archive.writestr(name, data)
    metadata_path = storage.archives / f"{archived}.json"
    metadata = json.loads(metadata_path.read_text())
    metadata.update(bytes=path.stat().st_size, sha256=hashlib.sha256(path.read_bytes()).hexdigest())
    metadata_path.write_text(json.dumps(metadata))
    with pytest.raises(ValueError, match="unsafe"):
        storage.restore("live", archived)
    assert not (storage.directory / identifier).exists()
    assert not (storage.directory / "outside.json").exists()


def test_interrupted_restore_and_partial_zip_bytes_are_reported_without_deletion(storage: CalculationStorage) -> None:
    identifier = run(storage)
    archived = storage.archive("live", [identifier])["archiveId"]
    hidden = storage.directory / f".restoring-{uuid.uuid4()}"
    (hidden / identifier).mkdir(parents=True)
    (hidden / identifier / "input.json").write_bytes(b"retained partial input" * 100)
    temporary = storage.archives / f".{uuid.uuid4()}.tmp"
    temporary.write_bytes(b"retained partial archive" * 100)
    expected = (hidden / identifier / "input.json").stat().st_size + temporary.stat().st_size
    restarted = CalculationStorage(JobManager(storage.directory))
    assert restarted.list("live")["unclassifiedBytes"] == expected
    assert restarted.list("live")["unreadableEntryCount"] == 2
    restarted.restore("live", archived)
    assert restarted.list("live")["unclassifiedBytes"] == expected
    assert (hidden / identifier / "input.json").exists()
    assert temporary.exists()


def test_published_zip_without_sidecar_is_reverified_and_listed_on_restart(storage: CalculationStorage) -> None:
    identifier = run(storage)
    archived = storage.archive("live", [identifier])["archiveId"]
    original_zip = (storage.archives / f"{archived}.zip").read_bytes()
    (storage.archives / f"{archived}.json").unlink()
    restarted = CalculationStorage(JobManager(storage.directory))
    listed = restarted.list("live")
    assert listed["archives"][0]["id"] == archived
    assert listed["unreadableEntryCount"] == 0
    assert (storage.archives / f"{archived}.zip").read_bytes() == original_zip
    assert restarted.restore("live", archived)["restoredRunCount"] == 1


def test_partial_sidecar_cannot_block_verified_archive_recovery(storage: CalculationStorage) -> None:
    identifier = run(storage)
    archived = storage.archive("live", [identifier])["archiveId"]
    (storage.archives / f"{archived}.json").unlink()
    partial = storage.archives / f"{archived}.json.tmp"
    partial.write_bytes(b'{"format":')
    restarted = CalculationStorage(JobManager(storage.directory))
    listed = restarted.list("live")
    assert listed["archives"][0]["id"] == archived
    assert listed["unclassifiedBytes"] == len(b'{"format":')
    assert partial.read_bytes() == b'{"format":'


def test_unclassified_symlink_bytes_never_follow_external_target(storage: CalculationStorage, tmp_path: Path) -> None:
    outside = tmp_path / "private"
    outside.mkdir()
    (outside / "data").write_bytes(b"private" * 10000)
    link = storage.directory / ".restoring-link"
    link.symlink_to(outside, target_is_directory=True)
    listed = storage.list("live")
    assert listed["unclassifiedBytes"] == link.lstat().st_size
    assert listed["unclassifiedBytes"] < (outside / "data").stat().st_size
    assert (outside / "data").exists()


@pytest.mark.parametrize("original, size", [(b"larger than recorded", 3), (b"short", 100)])
def test_evidence_copy_requires_its_exact_recorded_size(original: bytes, size: int) -> None:
    from io import BytesIO

    from mazal_engine.storage import _copy_evidence

    with pytest.raises(StorageConflict, match="changed size"):
        _copy_evidence(BytesIO(original), BytesIO(), size)

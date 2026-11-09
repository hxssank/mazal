from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field

router = APIRouter()


class ArchiveSelection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    runIds: list[str] = Field(min_length=1, max_length=20)


class RestoreSelection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    archiveId: str


def storage_failure(error: OSError) -> HTTPException:
    if isinstance(error, FileNotFoundError):
        return HTTPException(status_code=404, detail="Calculation evidence not found in this workspace.")
    return HTTPException(status_code=503, detail="Calculation storage is unavailable. Existing evidence was kept.")


@router.get("/storage")
def storage_usage(workspace: Literal["live", "demo"], request: Request) -> dict[str, Any]:
    try:
        return request.app.state.storage.list(workspace)
    except OSError as error:
        raise storage_failure(error) from error


@router.post("/storage/archive")
def archive_calculations(body: ArchiveSelection, workspace: Literal["live", "demo"], request: Request) -> dict[str, Any]:
    try:
        return request.app.state.storage.archive(workspace, body.runIds)
    except OSError as error:
        raise storage_failure(error) from error


@router.post("/storage/restore")
def restore_calculations(body: RestoreSelection, workspace: Literal["live", "demo"], request: Request) -> dict[str, Any]:
    try:
        return request.app.state.storage.restore(workspace, body.archiveId)
    except OSError as error:
        raise storage_failure(error) from error


@router.get("/storage/archives/{archive_id}/download")
def download_calculation_archive(archive_id: str, workspace: Literal["live", "demo"], request: Request) -> FileResponse:
    try:
        path, _manifest = request.app.state.storage.verified_archive(workspace, archive_id)
        return FileResponse(path, media_type="application/zip", filename=f"mazal-calculations-{archive_id}.zip", headers={
            "X-Mazal-Workspace": workspace, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        })
    except OSError as error:
        raise storage_failure(error) from error

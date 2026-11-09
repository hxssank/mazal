from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request

from ..jobs import JobLimitError, JobStorageError
from ..models import EngineRequest

router = APIRouter()


@router.post("/runs", status_code=202)
def create_run(body: EngineRequest, request: Request) -> dict[str, Any]:
    try:
        return request.app.state.jobs.submit(body)
    except JobLimitError as error:
        raise HTTPException(status_code=429, detail=str(error)) from error
    except JobStorageError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@router.get("/runs/{job_id}")
def read_run(job_id: str, workspace: str, request: Request) -> dict[str, Any]:
    try:
        return request.app.state.jobs.get(job_id, workspace)
    except (FileNotFoundError, ValueError) as error:
        raise HTTPException(status_code=404, detail="Run not found in this workspace.") from error


@router.delete("/runs/{job_id}")
def cancel_run(job_id: str, workspace: str, request: Request) -> dict[str, Any]:
    try:
        return request.app.state.jobs.cancel(job_id, workspace)
    except (FileNotFoundError, ValueError) as error:
        raise HTTPException(status_code=404, detail="Run not found in this workspace.") from error

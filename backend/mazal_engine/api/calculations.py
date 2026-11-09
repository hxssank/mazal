from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from .. import MODEL_VERSION
from ..models import EngineRequest
from ..services.calculations import project, readiness, summary

router = APIRouter()


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "modelVersion": MODEL_VERSION}


@router.post("/summary")
def calculate_summary(request: EngineRequest) -> dict[str, Any]:
    return summary(request)


@router.post("/readiness")
def calculate_readiness(request: EngineRequest) -> dict[str, Any]:
    return readiness(request)


@router.post("/project")
def calculate_project(request: EngineRequest) -> dict[str, Any]:
    return project(request)

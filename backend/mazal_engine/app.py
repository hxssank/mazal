from __future__ import annotations

import asyncio
import hmac
import os
import zipfile
from contextlib import asynccontextmanager
from importlib import import_module
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .api import calculations, runs, storage
from .jobs import JobManager
from .lifecycle import monitor_parent
from .storage import CalculationStorage, StorageConflict


@asynccontextmanager
async def lifespan(app: FastAPI):
    if os.name == "nt":
        # NumPy can deadlock while another thread reads pipe-backed stdin.
        # https://github.com/numpy/numpy/issues/24290
        import_module("numpy")
    stop_parent_monitor = monitor_parent()
    cache = Path(os.environ.get("MAZAL_ENGINE_CACHE_DIR", Path(__file__).resolve().parents[1] / ".cache"))
    cache.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.environ.setdefault("PYTENSOR_FLAGS", f"base_compiledir={cache / 'pytensor'}")
    app.state.jobs = JobManager(Path(os.environ.get("MAZAL_ENGINE_RUN_DIR", cache / "runs")))
    app.state.storage = CalculationStorage(app.state.jobs)

    async def reap_workers() -> None:
        while True:
            await asyncio.sleep(1)
            await asyncio.to_thread(app.state.jobs.reap)

    reaper = asyncio.create_task(reap_workers())
    try:
        yield
    finally:
        reaper.cancel()
        try:
            await reaper
        except asyncio.CancelledError:
            pass
        await asyncio.to_thread(app.state.jobs.close)
        stop_parent_monitor()


app = FastAPI(title="Mazal financial engine", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def local_authentication(request: Request, call_next):
    expected = os.environ.get("MAZAL_ENGINE_KEY", "")
    provided = request.headers.get("x-mazal-engine-key", "")
    if not expected or not hmac.compare_digest(expected, provided) or request.headers.get("origin"):
        return JSONResponse({"error": "Use Mazal's local API to access the financial engine."}, status_code=403)
    return await call_next(request)


@app.exception_handler(RequestValidationError)
async def validation_error(_request: Request, error: RequestValidationError):
    messages = [f"{'.'.join(str(part) for part in item['loc'][1:])}: {item['msg']}" for item in error.errors()]
    return JSONResponse({"error": "; ".join(messages[:8])}, status_code=422)


@app.exception_handler(ValueError)
async def value_error(_request: Request, error: ValueError):
    return JSONResponse({"error": str(error)}, status_code=422)


@app.exception_handler(HTTPException)
async def http_error(_request: Request, error: HTTPException):
    return JSONResponse({"error": error.detail}, status_code=error.status_code)


@app.exception_handler(StorageConflict)
async def storage_conflict(_request: Request, error: StorageConflict):
    return JSONResponse({"error": str(error)}, status_code=409)


@app.exception_handler(zipfile.BadZipFile)
async def archive_error(_request: Request, _error: zipfile.BadZipFile):
    return JSONResponse({"error": "The calculation archive is damaged. Existing evidence was kept."}, status_code=422)


app.include_router(calculations.router)
app.include_router(runs.router)
app.include_router(storage.router)

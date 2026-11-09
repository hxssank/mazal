from __future__ import annotations

import json
import time
from collections.abc import Iterator
from copy import deepcopy
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from mazal_engine.app import app

AUTH = {"x-mazal-engine-key": "synthetic-test-engine-secret"}


def request_data(**changes: Any) -> dict[str, Any]:
    return {
        "snapshot": {
            "workspace": "live", "revision": 3,
            "entities": [{"id": "personal", "name": "Personal", "kind": "personal", "ownershipBps": 10000}],
            "accounts": [
                {
                    "id": "cash", "entityId": "personal", "name": "Cash", "type": "cash", "currency": "CAD",
                    "balanceCents": 100_000, "reconciledAt": "2026-01-01",
                }
            ],
            "transactions": [], "obligations": [], "reserves": [], "positions": [],
            "audit": [], "lastBackupAt": None,
        },
        "scope": "personal", "asOf": "2026-01-01",
        **changes,
    }


def comparison_assumptions(**changes: Any) -> dict[str, Any]:
    return {
        "months": 1, "payCents": 100_000, "frequency": 26, "paydayAnchor": "2026-01-01",
        "monthlySpendingCents": 50_000, "reserveCents": 10_000, "annualReturnPercent": 0,
        "shockPercent": -30, "shockMonth": 1, "seed": 42, "userInvestmentShare": 0.5,
        **changes,
    }


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[TestClient]:
    monkeypatch.setenv("MAZAL_ENGINE_KEY", AUTH["x-mazal-engine-key"])
    monkeypatch.setenv("MAZAL_ENGINE_RUN_DIR", str(tmp_path / "runs"))
    monkeypatch.setenv("MAZAL_ENGINE_CACHE_DIR", str(tmp_path / "cache"))
    with TestClient(app, raise_server_exceptions=False) as current:
        yield current


def wait_for_run(client: TestClient, job_id: str, seconds: float = 30) -> dict[str, Any]:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        response = client.get(f"/runs/{job_id}?workspace=live", headers=AUTH)
        assert response.status_code == 200, response.text
        run = response.json()
        if run["status"] not in ("running", "queued"):
            return run
        time.sleep(0.05)
    pytest.fail(f"Run {job_id} did not finish within {seconds} seconds.")


@pytest.mark.parametrize("headers", [{}, {"x-mazal-engine-key": "wrong"}, {**AUTH, "origin": "http://localhost:5190"}])
@pytest.mark.parametrize("route", ["/health", "/summary", "/runs"])
def test_every_route_rejects_missing_wrong_or_browser_credentials(
    client: TestClient, headers: dict[str, str], route: str
) -> None:
    response = client.get(route, headers=headers) if route == "/health" else client.post(route, headers=headers, json=request_data())
    assert response.status_code == 403
    assert isinstance(response.json()["error"], str)


def test_engine_refuses_empty_configured_secret(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MAZAL_ENGINE_KEY", "")
    assert client.get("/health", headers=AUTH).status_code == 403


def test_authenticated_health_reports_model_version(client: TestClient) -> None:
    response = client.get("/health", headers=AUTH)
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert response.json()["modelVersion"]


@pytest.mark.parametrize("invalid", [{"scope": "unknown"}, {"asOf": "2026-02-30"}, {"kind": "unknown"}])
def test_invalid_calculation_identity_uses_json_error(client: TestClient, invalid: dict[str, str]) -> None:
    response = client.post("/project", headers=AUTH, json=request_data(**invalid))
    assert response.status_code == 422
    assert isinstance(response.json()["error"], str)
    assert "Traceback" not in response.text


def test_nonfinite_json_has_a_validation_error(client: TestClient) -> None:
    raw = request_data(assumptions={"return": float("nan")})
    response = client.post("/readiness", headers={**AUTH, "Content-Type": "application/json"}, content=json.dumps(raw))
    assert response.status_code == 422
    assert isinstance(response.json()["error"], str)


def test_payoff_envelope_and_calculation_leave_input_unchanged(client: TestClient) -> None:
    raw = request_data(kind="payoff", draft={"input": {"balanceCents": 100_000, "aprPercent": 0, "monthlyPaymentCents": 10_000}, "extraPaymentCents": 10_000})
    before = deepcopy(raw)
    response = client.post("/project", headers=AUTH, json=raw)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["workspace"] == "live"
    assert result["scope"] == "personal"
    assert result["revision"] == 3
    assert result["asOf"] == "2026-01-01"
    assert len(result["inputHash"]) == 64
    assert result["result"]["base"]["months"] == 10
    assert result["result"]["extra"]["months"] == 5
    assert result["result"]["savedMonths"] == 5
    assert result["result"]["savedInterest"] == 0
    assert raw == before


def test_readiness_reports_missing_inputs_without_inventing_values(client: TestClient) -> None:
    response = client.post("/readiness", headers=AUTH, json=request_data())
    assert response.status_code == 200, response.text
    result = response.json()["result"]
    assert result["ready"] is False
    assert {item["field"] for item in result["missingInputs"]} >= {
        "payCents", "monthlySpendingCents", "reserveCents", "annualReturnPercent", "paydayAnchor",
    }


def test_summary_returns_saved_balances_and_debt_totals(client: TestClient) -> None:
    response = client.post("/summary", headers=AUTH, json=request_data())
    assert response.status_code == 200, response.text
    result = response.json()["result"]
    assert result["summary"]["cashCents"] == 100_000
    assert result["summary"]["netWorthCents"] == 100_000
    assert result["summary"]["liabilitiesCents"] == 0
    assert result["debtOverview"]["debtCents"] == 0
    assert result["debtPaymentSummary"]["paidThisMonthCents"] == 0


def test_spending_calendar_returns_recorded_expenses_and_missing_coverage(client: TestClient) -> None:
    raw = request_data(kind="spending_calendar", draft={"month": "2026-01"})
    raw["snapshot"]["transactions"] = [
        {"id": "expense", "accountId": "cash", "date": "2026-01-01", "kind": "expense", "amountCents": 2500, "category": "Food", "description": "Synthetic food", "source": "Manual entry"},
    ]
    response = client.post("/project", headers=AUTH, json=raw)
    assert response.status_code == 200, response.text
    result = response.json()["result"]
    assert result["data"]["totalCents"] == 2500
    assert result["data"]["transactionCount"] == 1
    assert result["coverage"]["status"] == "none"


def test_background_comparison_completes_with_workspace_and_envelope(client: TestClient) -> None:
    raw = request_data(kind="comparison", assumptions=comparison_assumptions())
    before = deepcopy(raw)
    response = client.post("/runs", headers=AUTH, json=raw)
    assert response.status_code == 202, response.text
    run = wait_for_run(client, response.json()["id"])
    assert run["status"] == "completed", run
    assert run["workspace"] == "live"
    assert run["result"]["revision"] == 3
    assert run["result"]["result"]["status"] == "ready"
    assert run["result"]["result"]["policies"]
    for policy in run["result"]["result"]["policies"]:
        assert policy["netWorthCents"] == 100_000 + policy["totalIncomeCents"] - policy["totalSpendingCents"]
    assert raw == before


def test_background_spending_reports_insufficient_history(client: TestClient) -> None:
    response = client.post("/runs", headers=AUTH, json=request_data(kind="spending"))
    assert response.status_code == 202, response.text
    run = wait_for_run(client, response.json()["id"])
    assert run["status"] == "completed", run
    result = run["result"]["result"]
    assert result["status"] == "insufficient_history"
    assert result["completeWeeks"] == 0
    assert result["weeklyEstimateCents"] is None


def test_run_workspace_isolation_and_cancellation(client: TestClient) -> None:
    response = client.post("/runs", headers=AUTH, json=request_data(kind="comparison", assumptions=comparison_assumptions(months=60)))
    assert response.status_code == 202, response.text
    identifier = response.json()["id"]
    for method in (client.get, client.delete):
        wrong = method(f"/runs/{identifier}?workspace=demo", headers=AUTH)
        assert wrong.status_code == 404
        assert "error" in wrong.json()
    cancelled = client.delete(f"/runs/{identifier}?workspace=live", headers=AUTH)
    assert cancelled.status_code == 200, cancelled.text
    assert cancelled.json()["status"] == "cancelled"
    assert cancelled.json()["result"] is None
    again = client.delete(f"/runs/{identifier}?workspace=live", headers=AUTH)
    assert again.json()["status"] == "cancelled"


def test_worker_failure_has_error_and_no_partial_result(client: TestClient) -> None:
    raw = request_data(kind="comparison", assumptions=comparison_assumptions())
    raw["snapshot"]["entities"][0]["kind"] = "business"
    response = client.post("/runs", headers=AUTH, json=raw)
    assert response.status_code == 202, response.text
    run = wait_for_run(client, response.json()["id"])
    assert run["status"] == "failed", run
    assert isinstance(run["error"], str) and run["error"]
    assert run["result"] is None
    assert run["progress"] is None


def test_invalid_run_assumptions_fail_before_starting_worker(client: TestClient) -> None:
    response = client.post("/runs", headers=AUTH, json=request_data(kind="comparison", assumptions=comparison_assumptions(months=0)))
    assert response.status_code == 422
    assert isinstance(response.json()["error"], str)
    assert not app.state.jobs.processes


def test_invalid_run_identity_and_sync_project_inputs_return_errors(client: TestClient) -> None:
    invalid_run = client.get("/runs/not-a-uuid?workspace=live", headers=AUTH)
    assert invalid_run.status_code == 404
    assert "error" in invalid_run.json()
    invalid_project = client.post("/project", headers=AUTH, json=request_data(kind="payoff", draft={}))
    assert invalid_project.status_code == 422
    assert "error" in invalid_project.json()


@pytest.mark.parametrize("components", [{}, "bad", [None], [1], [[1]], [{"balanceCents": 0, "aprPercent": 0}] * 51])
def test_malformed_payoff_components_return_validation_error(client: TestClient, components: Any) -> None:
    response = client.post("/project", headers=AUTH, json=request_data(kind="payoff", draft={
        "input": {
            "balanceCents": 100_000, "aprPercent": 12,
            "monthlyPaymentCents": 10_000, "components": components,
        },
    }))
    assert response.status_code == 422, response.text
    assert "loan components" in response.json()["error"]
    assert client.get("/health", headers=AUTH).status_code == 200


def test_unwritable_run_cache_returns_retryable_json_error(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    def fail_write(_path: Path, _data: dict[str, Any]) -> None:
        raise OSError("Synthetic private-path storage failure")

    monkeypatch.setattr("mazal_engine.jobs._write", fail_write)
    response = client.post("/runs", headers=AUTH, json=request_data(kind="comparison"))
    assert response.status_code == 503
    assert "cache could not be saved" in response.json()["error"]
    assert "private-path" not in response.text
    assert not app.state.jobs.processes
    assert client.get("/health", headers=AUTH).status_code == 200


def test_storage_endpoints_archive_download_and_restore_exact_evidence(client: TestClient) -> None:
    from test_storage import run

    identifier = run(app.state.storage)
    folder = app.state.jobs.directory / identifier
    before = {path.name: path.read_bytes() for path in folder.iterdir()}
    listed = client.get("/storage?workspace=live", headers=AUTH)
    assert listed.status_code == 200
    assert listed.json()["runs"][0]["id"] == identifier
    archived = client.post("/storage/archive?workspace=live", headers=AUTH, json={"runIds": [identifier]})
    assert archived.status_code == 200, archived.text
    archive_id = archived.json()["archiveId"]
    downloaded = client.get(f"/storage/archives/{archive_id}/download?workspace=live", headers=AUTH)
    assert downloaded.status_code == 200
    assert downloaded.content[:2] == b"PK"
    assert downloaded.headers["content-type"] == "application/zip"
    assert downloaded.headers["x-mazal-workspace"] == "live"
    assert client.get(f"/storage/archives/{archive_id}/download?workspace=demo", headers=AUTH).status_code == 404
    assert client.post("/storage/restore?workspace=demo", headers=AUTH, json={"archiveId": archive_id}).status_code == 404
    restored = client.post("/storage/restore?workspace=live", headers=AUTH, json={"archiveId": archive_id})
    assert restored.status_code == 200, restored.text
    assert {path.name: path.read_bytes() for path in folder.iterdir()} == before


@pytest.mark.parametrize("path", ["/storage?workspace=live", "/storage/archive?workspace=live", "/storage/restore?workspace=live"])
def test_storage_requires_internal_authentication(client: TestClient, path: str) -> None:
    method = client.get if path.startswith("/storage?") else client.post
    assert method(path).status_code == 403


def test_daily_plan_endpoint_returns_dated_known_cash_and_missing_inputs(client: TestClient) -> None:
    raw = request_data(kind="daily_plan", draft={"days": 7})
    raw["snapshot"]["roadmap"] = {"payAmountCents": 200_000, "payEveryDays": 14, "paydayAnchor": "2026-01-02", "monthlyEssentialsCents": None}
    before = deepcopy(raw)
    response = client.post("/project", headers=AUTH, json=raw)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["revision"] == 3
    assert result["asOf"] == "2026-01-01"
    assert result["result"]["nextPayday"] == {"date": "2026-01-02", "amountCents": 200_000}
    assert result["result"]["status"] == "partial"
    assert len(result["result"]["days"]) == 7
    assert raw == before
    invalid = client.post("/project", headers=AUTH, json=request_data(kind="daily_plan", draft={"days": 91}))
    assert invalid.status_code == 422
    assert "7 and 90" in invalid.json()["error"]

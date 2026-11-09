from __future__ import annotations

from pathlib import Path
from typing import Any, get_args

import pytest

from mazal_engine.jobs import JobManager
from mazal_engine.models import CalculationKind, EngineRequest, envelope
from mazal_engine.services.calculations import CALCULATIONS, project, run_background


def calculation_request(kind: CalculationKind, **changes: Any) -> EngineRequest:
    return EngineRequest.model_validate({
        "snapshot": {
            "workspace": "demo", "revision": 8,
            "entities": [{"id": "personal", "name": "Personal", "kind": "personal", "ownershipBps": 10000}],
            "accounts": [], "transactions": [], "obligations": [], "reserves": [], "positions": [],
        },
        "scope": "personal", "asOf": "2026-01-01", "kind": kind,
        **changes,
    })


def test_every_valid_request_kind_has_an_execution_policy() -> None:
    assert set(CALCULATIONS) == set(get_args(CalculationKind))
    assert all(item.progress for item in CALCULATIONS.values() if item.execution == "background")


@pytest.mark.parametrize("kind", ["comparison", "spending"])
def test_inline_service_rejects_background_models_before_execution(
    kind: CalculationKind, monkeypatch: pytest.MonkeyPatch
) -> None:
    def unexpected_execution(_request: EngineRequest) -> dict[str, Any]:
        pytest.fail("A background model ran on the inline request path.")

    from dataclasses import replace

    monkeypatch.setattr("mazal_engine.services.calculations.CALCULATIONS", {
        **CALCULATIONS, kind: replace(CALCULATIONS[kind], execute=unexpected_execution),
    })
    with pytest.raises(ValueError, match="Use a background run"):
        project(calculation_request(kind))


@pytest.mark.parametrize("kind", ["planner", "daily_plan", "payoff", "spending_calendar"])
def test_background_admission_rejects_inline_requests_before_saving_evidence(
    kind: CalculationKind, tmp_path: Path
) -> None:
    request = calculation_request(kind)
    manager = JobManager(tmp_path)
    try:
        for execute in (run_background, manager.submit):
            with pytest.raises(ValueError, match="Background runs support"):
                execute(request)
        assert not manager.processes
        assert not list(tmp_path.iterdir())
    finally:
        manager.close()


def test_service_can_calculate_without_http_and_preserves_reproducible_inputs() -> None:
    request = calculation_request("payoff", draft={
        "input": {"balanceCents": 100_000, "aprPercent": 0, "monthlyPaymentCents": 10_000},
        "extraPaymentCents": 10_000,
    })
    before = request.model_dump()
    identity = envelope(request, None)
    result = project(request)
    assert result == {**identity, "result": result["result"]}
    assert result["result"]["base"]["months"] == 10
    assert result["result"]["extra"]["months"] == 5
    assert result["result"]["savedMonths"] == 5
    assert request.model_dump() == before

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, Literal

from ..models import CalculationKind, EngineRequest, envelope


@dataclass(frozen=True)
class Calculation:
    execute: Callable[[EngineRequest], dict[str, Any]]
    execution: Literal["inline", "background"]
    progress: str | None = None


def _planner(request: EngineRequest) -> dict[str, Any]:
    from ..planner import project

    return project(request.snapshot.model_dump(), request.scope, request.asOf, request.draft)


def _daily_plan(request: EngineRequest) -> dict[str, Any]:
    from ..daily_plan import daily_plan

    return daily_plan(request.snapshot.model_dump(), request.scope, request.asOf, request.draft)


def _payoff(request: EngineRequest) -> dict[str, Any]:
    from ..debt import compare_payoff

    if not isinstance(request.draft.get("input"), dict):
        raise ValueError("Provide the debt scenario inputs.")
    return compare_payoff(request.draft["input"], request.draft.get("extraPaymentCents", 0))


def _spending_calendar(request: EngineRequest) -> dict[str, Any]:
    from ..calendar import spending_calendar

    return spending_calendar(
        request.snapshot.model_dump(), request.scope, request.asOf, request.draft.get("month", "")
    )


def _comparison(request: EngineRequest) -> dict[str, Any]:
    from ..allocation import compare

    return compare(request.snapshot.model_dump(), request.scope, request.asOf, request.assumptions)


def _spending(request: EngineRequest) -> dict[str, Any]:
    from ..spending import analyze_spending

    return analyze_spending(request.snapshot.model_dump(), request.scope, request.asOf, request.assumptions)


CALCULATIONS: Mapping[CalculationKind, Calculation] = MappingProxyType({
    "planner": Calculation(_planner, "inline"),
    "daily_plan": Calculation(_daily_plan, "inline"),
    "payoff": Calculation(_payoff, "inline"),
    "spending_calendar": Calculation(_spending_calendar, "inline"),
    "comparison": Calculation(_comparison, "background", "Comparing funding policies"),
    "spending": Calculation(_spending, "background", "Checking spending models"),
})


def background_calculation(kind: CalculationKind) -> Calculation:
    calculation = CALCULATIONS[kind]
    if calculation.execution != "background":
        raise ValueError("Background runs support comparison and spending analysis.")
    return calculation


def project(request: EngineRequest) -> dict[str, Any]:
    calculation = CALCULATIONS[request.kind]
    if calculation.execution != "inline":
        raise ValueError("Use a background run for allocation comparisons and spending models.")
    return envelope(request, calculation.execute(request))


def run_background(request: EngineRequest) -> dict[str, Any]:
    calculation = background_calculation(request.kind)
    return envelope(request, calculation.execute(request))


def summary(request: EngineRequest) -> dict[str, Any]:
    from ..summary import summary as calculate_summary

    return envelope(request, calculate_summary(request.snapshot.model_dump(), request.scope, request.asOf))


def readiness(request: EngineRequest) -> dict[str, Any]:
    from ..allocation import readiness as calculate_readiness

    return envelope(request, calculate_readiness(
        request.snapshot.model_dump(), request.scope, request.asOf, request.assumptions
    ))

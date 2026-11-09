import json
import shutil
import subprocess
from copy import deepcopy
from pathlib import Path
from typing import Any

import pytest

from mazal_engine.planner import planner_debt_projection, planner_defaults, project, simulate_planner


def sample_input(**changes: Any) -> dict[str, Any]:
    return {
        "startMonth": "2026-10",
        "months": 12,
        "payCents": 150_000,
        "frequency": 26,
        "paydayAnchor": "2026-10-01",
        "monthlyMomCents": 100_000,
        "momRemainingCents": 2_000_000,
        "monthlyDebtCents": 100_000,
        "monthlySpendingCents": 50_000,
        "debts": [
            {
                "id": "card",
                "name": "Credit card",
                "balanceCents": 600_000,
                "aprPercent": 13,
                "minimumCents": 10_000,
            }
        ],
        "startingCashCents": 0,
        "startingInvestmentsCents": 0,
        "surplusDestination": "investments",
        "annualReturnPercent": 0,
        "extraDebtCents": 0,
        "strategy": "selected",
        "selectedDebtId": "card",
        **changes,
    }


def test_paycheck_and_daily_balance_conservation() -> None:
    input = sample_input(
        annualReturnPercent=7,
        months=60,
        extraDebtCents=27113,
        startingInvestmentsCents=90001,
        startingCashCents=5011,
    )
    before = deepcopy(input)
    result = simulate_planner(input)
    assert input == before
    assert len(result["months"]) == 60
    assert [pay["date"] for pay in result["paychecks"][:3]] == ["2026-10-01", "2026-10-15", "2026-10-29"]
    assert [pay["targets"]["momCents"] for pay in result["paychecks"][:3]] == [33334, 33333, 33333]
    for pay in result["paychecks"]:
        assert pay["payCents"] == sum(
            pay[field] for field in ("spendingCents", "momCents", "debtCents", "investCents", "cashCents")
        )
        assert pay["debtCents"] == sum(item["amountCents"] for item in pay["debtPayments"])
    for day in result["days"]:
        assert day["debtCents"] == 600_000 + day["interestCents"] - sum(
            debt["paymentCents"] for debt in day["debts"]
        )
        assert (
            day["investmentsCents"]
            == 90001 + day["investmentContributionsCents"] + day["investmentGrowthCents"]
        )
        assert day["cashCents"] == 5011 + day["cashContributionsCents"]


def test_late_payments_remain_late_and_earlier_funding_respects_budget() -> None:
    debt = {
        "id": "loan",
        "name": "Card",
        "balanceCents": 100_000,
        "aprPercent": 0,
        "minimumCents": 10_000,
        "minimumDueDate": "2026-10-01",
    }
    input = sample_input(
        months=1,
        paydayAnchor="2026-10-15",
        monthlyMomCents=0,
        monthlySpendingCents=0,
        monthlyDebtCents=10000,
        debts=[debt],
        selectedDebtId="loan",
    )
    late = simulate_planner(input)
    assert late["totalMinimumShortfallCents"] == 10000
    assert sum(pay["debtCents"] for pay in late["paychecks"]) == 10000
    early = simulate_planner({**input, "debts": [{**debt, "minimumDueDate": "2026-10-20"}]})
    assert early["totalMinimumShortfallCents"] == 0
    assert [pay["debtCents"] for pay in early["paychecks"]] == [10000, 0]


def test_deferral_expiry_and_unknown_minimums() -> None:
    debt = {
        "id": "loan",
        "name": "Student loan",
        "balanceCents": 100_000,
        "aprPercent": 0,
        "minimumCents": 0,
        "paymentsDeferred": True,
        "studyEndDate": "2027-01-31",
    }
    result = simulate_planner(
        sample_input(
            startMonth="2027-01",
            months=2,
            paydayAnchor="2027-01-15",
            monthlyDebtCents=0,
            debts=[debt],
            selectedDebtId="loan",
        )
    )
    assert [month["unknownMinimumCount"] for month in result["months"]] == [0, 1]
    assert result["monthsWithUnknownMinimums"] == 1


def test_existing_cash_is_not_silently_used_in_legacy_planner() -> None:
    input = sample_input(months=1, payCents=0, startingCashCents=500_000, surplusDestination="cash")
    result = simulate_planner(input)
    assert result["days"][-1]["cashCents"] == 500_000
    assert result["totalShortfallCents"] == 250_000
    assert result["days"][-1]["investmentContributionsCents"] == 0


def test_zero_minimum_scenario_names_the_unconfirmed_future_payment_assumption() -> None:
    inputs = sample_input(months=2, monthlyDebtCents=0)
    inputs["debts"][0]["minimumCents"] = 0
    result = simulate_planner(inputs)
    assert any("$0 minimum despite a remaining balance" in warning for warning in result["warnings"])


def test_effective_return_applies_before_daily_contributions() -> None:
    result = simulate_planner(
        sample_input(
            startMonth="2027-01",
            months=12,
            paydayAnchor="2027-01-01",
            annualReturnPercent=12,
            startingInvestmentsCents=100_000,
            surplusDestination="cash",
        )
    )
    assert result["days"][-1]["investmentsCents"] == 112_000
    assert result["days"][-1]["investmentContributionsCents"] == 0
    leap = simulate_planner(
        sample_input(
            startMonth="2028-02",
            months=1,
            payCents=0,
            monthlyMomCents=0,
            monthlySpendingCents=0,
            monthlyDebtCents=0,
        )
    )
    assert len(leap["days"]) == 29
    assert leap["days"][0]["interestCents"] == 214


def snapshot() -> dict[str, Any]:
    return {
        "entities": [{"id": "me", "kind": "personal"}, {"id": "business", "kind": "business"}],
        "accounts": [
            {"id": "cash", "entityId": "me", "type": "cash", "balanceCents": 12345},
            {"id": "business-cash", "entityId": "business", "type": "cash", "balanceCents": 1_000_000},
            {
                "id": "card",
                "name": "Card",
                "entityId": "me",
                "type": "debt",
                "balanceCents": 600_000,
                "debtTerms": {
                    "aprPercent": 13,
                    "rateConfirmed": True,
                    "minimumPaymentCents": 10000,
                    "paymentDueDate": "2026-10-15",
                },
            },
        ],
        "roadmap": {
            "payAmountCents": 150_000,
            "monthlyFamilyPaymentCents": 100_000,
            "monthlyDebtMinimumsCents": 100_000,
            "monthlyEssentialsCents": 50_000,
            "payEveryDays": 14,
            "paydayAnchor": "2026-10-01",
        },
    }


def test_project_supplies_old_ui_shape_and_server_totals_without_writes() -> None:
    state = snapshot()
    before = deepcopy(state)
    result = project(state, "all", "2026-09-26", {})
    assert result["error"] == ""
    assert result["input"]["startingCashCents"] == 12345
    assert result["derived"]["startingCash"] == 12345
    assert result["derived"]["unallocatedCents"] == 50000
    assert result["derived"]["totalPayCents"] == sum(pay["payCents"] for pay in result["result"]["paychecks"])
    assert result["points"][0]["netWorthCents"] == 12345 - 600_000
    assert (
        result["result"]["days"][0]["debtReducedCents"] == 600_000 - result["result"]["days"][0]["debtCents"]
    )
    assert result["derived"]["selectedDebtEarlyPaymentSavingsCents"] == 249
    assert state == before


def test_defaults_preserve_unknowns_and_excluded_debt() -> None:
    state = snapshot()
    state["roadmap"] = {}
    deferred = {
        "id": "osap",
        "entityId": "me",
        "name": "OSAP",
        "type": "debt",
        "balanceCents": 1_192_000,
        "debtTerms": {"aprPercent": None, "repaymentStatus": "in_study", "minimumPaymentCents": None},
    }
    state["accounts"].append(deferred)
    defaults = planner_defaults(state, "me", "2026-09-26")
    assert defaults["pay"] == ""
    assert defaults["investmentReturn"] == "0"
    assert defaults["debts"]["osap"] == {"balance": "11920", "apr": "", "minimum": "0", "included": False}
    projection = planner_debt_projection([deferred], defaults["debts"])
    assert projection["fixedDebtCents"] == 1_192_000
    with pytest.raises(ValueError, match="APR"):
        planner_debt_projection([deferred], {"osap": {**defaults["debts"]["osap"], "included": True}})


def test_missing_inputs_and_invalid_scope_return_reviewable_errors() -> None:
    assert project(snapshot(), "missing", "2026-09-26", {})["result"] is None
    assert "owner" in project(snapshot(), "missing", "2026-09-26", {})["error"]
    result = project(snapshot(), "all", "2026-09-26", {"pay": ""})
    assert result["input"] is None
    assert "Take-home pay" in result["error"]
    assert result["derived"]["startingCash"] == 12345


@pytest.mark.parametrize(
    "draft",
    [
        {"debts": []},
        {"debts": {"card": {"apr": 13}}},
        {"debts": {"card": {"included": "true"}}},
        {"pay": 1_000},
    ],
)
def test_malformed_drafts_return_validation_errors(draft: dict[str, Any]) -> None:
    result = project(snapshot(), "all", "2026-09-26", draft)
    assert result["error"]
    assert result["result"] is None


@pytest.mark.parametrize(
    "change",
    [
        {"months": 61},
        {"months": True},
        {"frequency": 13},
        {"payCents": 0.5},
        {"annualReturnPercent": float("nan")},
        {"selectedDebtId": "missing"},
        {"paydayAnchor": "2026-02-30"},
    ],
)
def test_invalid_inputs_fail_before_projection(change: dict[str, Any]) -> None:
    with pytest.raises(ValueError):
        simulate_planner(sample_input(**change))


@pytest.mark.parametrize("components", [{}, "bad", [None], [1], [[1]], [{"balanceCents": 0, "aprPercent": 0}] * 51])
def test_malformed_debt_components_fail_before_projection(components: Any) -> None:
    input = sample_input()
    input["debts"][0]["components"] = components
    with pytest.raises(ValueError, match="loan components"):
        simulate_planner(input)


def test_python_matches_legacy_typescript_across_calendar_and_contract_cases() -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node is required for migration parity checks.")
    cases = [
        sample_input(),
        sample_input(months=24, annualReturnPercent=7, extraDebtCents=27113),
        sample_input(months=1, frequency=52),
        sample_input(months=3, startMonth="2028-01", paydayAnchor="2028-01-31", frequency=12),
        sample_input(months=1, payCents=0),
        sample_input(months=1, debts=[], selectedDebtId=None),
        sample_input(months=2, startingCashCents=-10000, surplusDestination="cash"),
        sample_input(months=2, annualReturnPercent=-100, startingInvestmentsCents=50000),
        sample_input(months=2, paydayAnchor="2026-12-01"),
        sample_input(months=2, momRemainingCents=None),
    ]
    debt = {
        "id": "card",
        "name": "Card",
        "balanceCents": 1_000_000,
        "aprPercent": 12,
        "minimumCents": 5000,
        "minimumDueDate": "2026-10-15",
    }
    for kind in ("fixed", "revolving", "interest_only", "one_off"):
        cases.append(sample_input(months=3, debts=[{**debt, "repaymentKind": kind}]))
    cases.extend(
        [
            sample_input(
                months=3,
                monthlyDebtCents=0,
                debts=[{**debt, "paymentsDeferred": True, "repaymentStartDate": "2026-11-01"}],
            ),
            sample_input(
                months=3,
                monthlyDebtCents=0,
                debts=[{**debt, "paymentsDeferred": True, "studyEndDate": "2026-10-31"}],
            ),
            sample_input(
                months=3,
                debts=[
                    {
                        **debt,
                        "balanceCents": 1_000_000,
                        "aprPercent": 1.2,
                        "components": [
                            {"balanceCents": 800_000, "aprPercent": 0},
                            {"balanceCents": 200_000, "aprPercent": 6},
                        ],
                    }
                ],
            ),
        ]
    )
    script = "import {simulatePlanner} from './shared/planner.ts'; let s=''; for await (const c of process.stdin) s+=c; process.stdout.write(JSON.stringify(JSON.parse(s).map(simulatePlanner)));"
    result = subprocess.run(
        [node, "--experimental-strip-types", "--input-type=module", "-e", script],
        cwd=Path(__file__).parents[2],
        input=json.dumps(cases),
        text=True,
        capture_output=True,
        check=True,
    )
    expected = json.loads(result.stdout)
    for index, (input, legacy) in enumerate(zip(cases, expected, strict=True)):
        assert simulate_planner(input) == legacy, f"Legacy planner case {index} differs"


def test_snapshot_planner_cannot_project_present_balances_from_a_past_month_start() -> None:
    result = project(snapshot(), "all", "2026-10-02", {"startMonth": "2026-10"})
    assert result["result"] is None
    assert "Earlier activity is already included" in result["error"]


def test_snapshot_planner_excludes_today_payday_from_current_balances() -> None:
    result = project(snapshot(), "all", "2026-10-01", {"months": "1"})
    assert not result["error"]
    assert [pay["date"] for pay in result["result"]["paychecks"]] == ["2026-10-15", "2026-10-29"]
    assert any("Today's scheduled paycheck is excluded" in warning for warning in result["result"]["warnings"])


def test_personal_planner_prorates_each_check_using_the_draft_full_time_pay() -> None:
    state = snapshot()
    state["roadmap"].update(
        transitionDate="2027-01-01", paydayAnchor="2026-10-29",
        temporaryWorkSchedule={"weeklyHours": 20, "fullTimeWeeklyHours": 37.5,
                               "returnDate": "2027-05-01", "payPeriodEndLagDays": 12},
    )
    result = project(state, "me", "2026-09-26", {"startMonth": "2027-01", "pay": "1800", "months": "5"})
    assert not result["error"]
    assert result["input"]["payByDateCents"]["2027-01-21"] == 129_600
    for scenario in ("result", "baseline", "faster"):
        checks = {pay["date"]: pay["payCents"] for pay in result[scenario]["paychecks"]}
        assert checks["2027-01-07"] == checks["2027-05-27"] == 180_000
        assert checks["2027-02-04"] == checks["2027-05-13"] == 96_000
        assert result[scenario]["months"][0]["incomeCents"] == 309_600
    assert result["derived"]["normalRemainder"] == 109_600
    april = project(state, "me", "2026-09-26", {"startMonth": "2027-04", "months": "2"})
    assert april["derived"]["normalPaychecks"] == 2
    assert [month["month"] for month in april["derived"]["thirdPayMonths"]] == ["2027-04"]

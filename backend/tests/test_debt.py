import json
import shutil
import subprocess
from copy import deepcopy
from pathlib import Path
from typing import Any

import pytest

from mazal_engine.debt import (
    compare_payoff,
    debt_interest_parts,
    debt_overview,
    debt_payment_status,
    debt_payment_summary,
    effective_debt_apr,
    js_round,
    payoff,
    required_debt_payment_cents,
)


def account(**terms: Any) -> dict[str, Any]:
    return {
        "id": "loan",
        "name": "Loan",
        "entityId": "me",
        "type": "debt",
        "currency": "CAD",
        "balanceCents": 1_000_000,
        "debtTerms": {"aprPercent": 6, "rateConfirmed": True, "minimumPaymentCents": 10_000, **terms},
    }


def test_unknown_rates_and_zero_balances_are_distinct() -> None:
    assert payoff({"balanceCents": 0, "aprPercent": None, "monthlyPaymentCents": 0}) == {
        "status": "paid_off",
        "months": 0,
        "totalInterestCents": 0,
        "schedule": [],
    }
    assert payoff({"balanceCents": 100_000, "aprPercent": None, "monthlyPaymentCents": 10_000}) == {
        "status": "needs_inputs",
        "months": None,
        "totalInterestCents": None,
        "schedule": [],
    }
    assert (
        payoff({"balanceCents": 10_000, "aprPercent": 0, "monthlyPaymentCents": 3_000})["schedule"][-1][
            "paymentCents"
        ]
        == 1_000
    )


def test_payoff_rounding_conserves_principal_and_interest() -> None:
    result = payoff({"balanceCents": 100_000, "aprPercent": 12, "monthlyPaymentCents": 10_000})
    assert (result["months"], result["totalInterestCents"]) == (11, 5898)
    assert result["schedule"][1] == {
        "month": 2,
        "balanceCents": 81910,
        "paymentCents": 10000,
        "interestCents": 910,
    }
    assert sum(row["paymentCents"] for row in result["schedule"]) - 100_000 == result["totalInterestCents"]
    comparison = compare_payoff(
        {"balanceCents": 100_000, "aprPercent": 12, "monthlyPaymentCents": 10_000}, 10_000
    )
    assert comparison["savedMonths"] == 5
    assert comparison["savedInterest"] > 0


@pytest.mark.parametrize("payment", [0, 999, 1000])
def test_below_interest_does_not_claim_payoff(payment: int) -> None:
    result = payoff({"balanceCents": 100_000, "aprPercent": 12, "monthlyPaymentCents": payment})
    assert result["status"] == "below_interest"
    assert result["months"] is None


def test_interest_only_and_horizon_are_explicit() -> None:
    input = {
        "balanceCents": 1_000_000,
        "aprPercent": 12,
        "monthlyPaymentCents": 10_000,
        "repaymentKind": "interest_only",
    }
    assert payoff(input)["status"] == "interest_only"
    result = payoff({**input, "extraPaymentCents": 50_000})
    assert (result["months"], result["totalInterestCents"]) == (20, 105_000)
    assert result["schedule"][1]["paymentCents"] == 59_500
    limited = payoff({**input, "repaymentKind": "fixed", "maxMonths": 3, "extraPaymentCents": 10_000})
    assert limited["status"] == "beyond_horizon"
    assert limited["totalInterestCents"] is None


def test_split_unknowns_and_confirmed_rates() -> None:
    loan = account(
        components=[
            {
                "id": "federal",
                "balanceCents": 800_000,
                "aprPercent": None,
                "rateConfirmed": False,
                "interestStatus": "unknown",
            },
            {
                "id": "ontario",
                "balanceCents": 200_000,
                "aprPercent": 6,
                "rateConfirmed": True,
                "interestStatus": "accruing",
            },
        ]
    )
    assert effective_debt_apr(loan) is None
    loan["debtTerms"]["components"][0]["interestStatus"] = "interest_free"
    assert effective_debt_apr(loan, True) == 1.2
    assert debt_interest_parts(loan) == [
        {"balanceCents": 800_000, "aprPercent": 0},
        {"balanceCents": 200_000, "aprPercent": 6},
    ]
    loan["balanceCents"] -= 1
    assert debt_interest_parts(loan) is None


def test_deferral_end_never_invents_repayment_date() -> None:
    loan = account(repaymentStatus="in_study", studyEndDate="2026-12-31")
    assert debt_payment_status(loan, "2026-12-31") == "in_study"
    assert required_debt_payment_cents(loan, "2026-12-31") == 0
    assert debt_payment_status(loan, "2027-01-01") == "needs_confirmation"
    assert required_debt_payment_cents(loan, "2027-01-01") is None
    assert debt_payment_summary([loan], "2027-01-01")["unknownPayments"] == 1
    loan["debtTerms"]["repaymentStartDate"] = "2027-07-01"
    assert debt_payment_status(loan, "2027-06-30") == "in_study"
    assert debt_payment_status(loan, "2027-07-01") == "repaying"


def test_overview_counts_credits_without_interest_and_does_not_mutate() -> None:
    loan = account()
    credit = {**account(), "id": "credit", "balanceCents": -5000}
    unknown = {**account(aprPercent=None, rateConfirmed=False), "id": "unknown"}
    inputs = [loan, credit, unknown]
    before = deepcopy(inputs)
    result = debt_overview(inputs, "2026-10-01")
    assert result["debtCents"] == 2_000_000
    assert result["creditCents"] == 5000
    assert result["monthlyInterestCents"] == 5000
    assert result["unknownInterestCount"] == 1
    assert result["highestRateAccountId"] == "loan"
    assert inputs == before


@pytest.mark.parametrize(
    "change",
    [
        {"balanceCents": -1},
        {"monthlyPaymentCents": 0.5},
        {"aprPercent": float("nan")},
        {"maxMonths": 0},
        {"balanceCents": True},
        {"extraPaymentCents": 9_007_199_254_740_991},
    ],
)
def test_invalid_payoff_inputs_fail(change: dict[str, Any]) -> None:
    with pytest.raises(ValueError):
        payoff({"balanceCents": 100_000, "aprPercent": 12, "monthlyPaymentCents": 10_000, **change})


def test_payoff_matches_legacy_monthly_interest_and_component_contracts() -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node is required for migration parity checks.")
    common = {"balanceCents": 1_000_000, "aprPercent": 12, "monthlyPaymentCents": 50_000}
    cases = [
        common,
        {**common, "aprPercent": None},
        {**common, "aprPercent": 0},
        {**common, "balanceCents": 0, "aprPercent": None},
        {**common, "maxMonths": 3},
        {**common, "monthlyPaymentCents": 100},
        {**common, "repaymentKind": "interest_only"},
        {**common, "repaymentKind": "interest_only", "extraPaymentCents": 50_000},
        {**common, "repaymentKind": "one_off"},
        {**common, "repaymentKind": "one_off", "extraPaymentCents": 10_000},
        {
            **common,
            "aprPercent": 1.2,
            "components": [
                {"balanceCents": 800_000, "aprPercent": 0},
                {"balanceCents": 200_000, "aprPercent": 6},
            ],
        },
    ]
    script = "import {calculatePayoff} from './shared/roadmap.ts'; let s=''; for await (const c of process.stdin) s+=c; process.stdout.write(JSON.stringify(JSON.parse(s).map(calculatePayoff)));"
    output = subprocess.run(
        [node, "--experimental-strip-types", "--input-type=module", "-e", script],
        cwd=Path(__file__).parents[2],
        input=json.dumps(cases),
        text=True,
        capture_output=True,
        check=True,
    )
    assert [payoff(case) for case in cases] == json.loads(output.stdout)


@pytest.mark.parametrize("value", [4_503_599_627_370_497, 9_007_199_254_740_991])
def test_rounding_preserves_already_exact_integer_cents(value: int) -> None:
    assert js_round(value) == value
    assert js_round(float(value)) == value
    assert js_round(-value) == -value


@pytest.mark.parametrize("value,expected", [(0.5, 1), (-0.5, 0), (1.49, 1), (-1.5, -1)])
def test_rounding_ties_match_javascript(value: float, expected: int) -> None:
    assert js_round(value) == expected

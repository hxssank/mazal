import json
import os
import shutil
import subprocess
from copy import deepcopy
from pathlib import Path
from typing import Any

import pytest

from mazal_engine.debt import MAX_SAFE_CENTS
from mazal_engine.summary import recorded_summary, summary, upcoming, weighted_cents


def state_fixture() -> dict[str, Any]:
    return {
        "workspace": "demo",
        "revision": 1,
        "entities": [
            {"id": "me", "name": "Personal", "kind": "personal", "ownershipBps": 10000},
            {"id": "business", "name": "Business", "kind": "business", "ownershipBps": 5000},
        ],
        "accounts": [
            {"id": "cash", "entityId": "me", "name": "Cash", "type": "cash", "balanceCents": 100000},
            {
                "id": "investments",
                "entityId": "me",
                "name": "Investments",
                "type": "investment",
                "balanceCents": 50000,
            },
            {
                "id": "card",
                "entityId": "me",
                "name": "Card",
                "type": "debt",
                "balanceCents": 20000,
                "debtTerms": {"aprPercent": 20, "rateConfirmed": True, "minimumPaymentCents": 2000},
            },
            {
                "id": "business-cash",
                "entityId": "business",
                "name": "Business cash",
                "type": "cash",
                "balanceCents": 200000,
            },
            {
                "id": "receivable",
                "entityId": "business",
                "name": "Receivable",
                "type": "receivable",
                "balanceCents": 40000,
            },
            {
                "id": "payable",
                "entityId": "business",
                "name": "Payable",
                "type": "payable",
                "balanceCents": 40000,
                "debtTerms": {"aprPercent": None, "rateConfirmed": False, "minimumPaymentCents": None},
            },
        ],
        "reserves": [
            {"id": "reserve", "entityId": "me", "amountCents": 10000},
            {"id": "business-reserve", "entityId": "business", "amountCents": 20000},
        ],
        "obligations": [
            {
                "id": "bill",
                "entityId": "me",
                "name": "Bill",
                "amountCents": 10000,
                "dueDate": "2026-10-01",
                "direction": "out",
                "status": "planned",
                "recurrence": "once",
                "category": "Bills",
            },
            {
                "id": "business-bill",
                "entityId": "business",
                "name": "Business bill",
                "amountCents": 20000,
                "dueDate": "2026-10-01",
                "direction": "out",
                "status": "planned",
                "recurrence": "once",
                "category": "Bills",
            },
        ],
        "transactions": [
            {"id": "pay", "accountId": "cash", "date": "2026-09-01", "kind": "income", "amountCents": 30000},
            {
                "id": "business-pay",
                "accountId": "business-cash",
                "date": "2026-09-01",
                "kind": "income",
                "amountCents": 100000,
            },
            {
                "id": "expense",
                "accountId": "cash",
                "date": "2026-09-02",
                "kind": "expense",
                "amountCents": 5000,
            },
            {
                "id": "business-expense",
                "accountId": "business-cash",
                "date": "2026-09-02",
                "kind": "expense",
                "amountCents": 10000,
            },
        ],
        "moneyOwed": [],
        "assetPurchases": [],
        "assets": [],
        "positions": [],
        "spendingLimits": [],
        "statements": [],
        "importBatches": [],
    }


def test_recorded_summary_preserves_scope_and_personal_cash() -> None:
    state = state_fixture()
    before = deepcopy(state)
    totals = recorded_summary(state, "all", "2026-09-26")
    assert totals == {
        "assetsCents": 270000,
        "liabilitiesCents": 40000,
        "netWorthCents": 230000,
        "cashCents": 200000,
        "investmentsCents": 50000,
        "receivablesCents": 20000,
        "physicalAssetsCents": 0,
        "purchaseEquityCents": 0,
        "availableCents": 80000,
        "reservedCents": 20000,
        "committedCents": 20000,
        "incomeCents": 80000,
        "expensesCents": 10000,
        "personalAvailableCents": 80000,
    }
    business = recorded_summary(state, "business", "2026-09-26")
    assert business["cashCents"] == 200000
    assert business["availableCents"] == 160000
    assert business["personalAvailableCents"] == 80000
    assert state == before


def test_recorded_purchase_equity_and_receivables_are_counted_once() -> None:
    state = state_fixture()
    state["moneyOwed"] = [
        {"id": "receivable", "entityId": "business", "amountCents": 100000, "payments": []},
        {"id": "tab", "entityId": "me", "amountCents": 10000, "payments": [{"amountCents": 12000}]},
    ]
    state["assetPurchases"] = [
        {"id": "car", "entityId": "me", "targetCents": 900000, "paidCents": 123456},
        {"id": "unknown-purchase", "entityId": "me", "targetCents": 50000, "paidCents": None},
    ]
    state["assets"] = [
        {"id": "car", "entityId": "me", "status": "owned", "estimatedValueCents": 800000, "feesCents": 1000},
        {"id": "bike", "entityId": "me", "status": "owned", "estimatedValueCents": 12000, "feesCents": 500},
        {"id": "sold", "entityId": "me", "status": "sold", "estimatedValueCents": 90000, "feesCents": 0},
        {"id": "unknown", "entityId": "me", "status": "owned", "estimatedValueCents": None, "feesCents": 0},
    ]
    result = summary(state, "me", "2026-09-26")
    assert result["summary"]["receivablesCents"] == -2000
    assert result["summary"]["purchaseEquityCents"] == 123456
    assert result["summary"]["physicalAssetsCents"] == 11500
    assert result["trackedAssetsCents"] == 132956
    assert result["summary"]["cashCents"] == 100000


@pytest.mark.parametrize(("paid_cents", "committed_cents", "weighted_cents"), [
    (74_999, 25_001, 12_501), (100_000, 0, 0), (None, 0, 0),
])
def test_summary_caps_shared_purchase_installments(
    paid_cents: int | None, committed_cents: int, weighted_cents: int,
) -> None:
    state = state_fixture()
    state["reserves"] = []
    state["assetPurchases"] = [
        {"id": f"{owner}-purchase", "entityId": owner, "targetCents": 100_000, "paidCents": paid_cents}
        for owner in ("me", "business")
    ]
    bill = state["obligations"][0]
    state["obligations"] = [
        {**bill, "id": f"{purchase['id']}-{suffix}", "entityId": purchase["entityId"],
         "assetPurchaseId": purchase["id"], "dueDate": when, "recurrence": recurrence}
        for purchase in state["assetPurchases"]
        for suffix, when, recurrence in (
            ("recurring", "2026-10-16", "biweekly"), ("extra", "2026-10-17", "once"),
        )
    ]
    state["obligations"].append({**bill, "id": "ordinary", "dueDate": "2026-10-17", "amountCents": 5_000})
    before = deepcopy(state)
    combined = recorded_summary(state, "all", "2026-10-16")
    assert combined["committedCents"] == 5_000 + committed_cents + weighted_cents
    assert combined["availableCents"] == 95_000 - committed_cents
    assert combined["personalAvailableCents"] == 95_000 - committed_cents
    personal = recorded_summary(state, "me", "2026-10-16")
    assert personal["committedCents"] == 5_000 + committed_cents
    assert personal["availableCents"] == 95_000 - committed_cents
    business = recorded_summary(state, "business", "2026-10-16")
    assert business["committedCents"] == committed_cents
    assert business["availableCents"] == 200_000 - committed_cents
    assert business["personalAvailableCents"] == personal["personalAvailableCents"]
    assert state == before


def test_debt_payment_imports_reversals_and_unknown_largest_apr() -> None:
    state = state_fixture()
    state["transactions"] = [
        {
            "id": "paid",
            "accountId": "cash",
            "toAccountId": "card",
            "date": "2026-09-02",
            "kind": "debt_payment",
            "amountCents": 5000,
        },
        {
            "id": "legacy",
            "accountId": "card",
            "date": "2026-09-03",
            "kind": "adjustment",
            "amountCents": 3000,
            "statementId": "statement",
            "category": " Ｃａｒｄ  payment ",
        },
        {
            "id": "import",
            "accountId": "card",
            "date": "2026-09-04",
            "kind": "adjustment",
            "amountCents": 4000,
            "importSources": [{"importId": "batch", "rowId": "row"}],
            "category": "Card payment",
            "balanceChanges": {"card": -4000},
        },
        {
            "id": "reverse",
            "accountId": "card",
            "date": "2026-09-05",
            "kind": "adjustment",
            "amountCents": 2000,
            "importSources": [{"importId": "batch", "rowId": "row2"}],
            "category": "Card payment",
            "balanceChanges": {"card": 2000},
        },
        {
            "id": "cash-match",
            "accountId": "cash",
            "date": "2026-09-04",
            "kind": "adjustment",
            "amountCents": 4000,
            "statementId": "cash-statement",
            "category": "Card payment",
        },
        {
            "id": "future",
            "accountId": "cash",
            "toAccountId": "card",
            "date": "2026-09-30",
            "kind": "debt_payment",
            "amountCents": 9000,
        },
    ]
    result = summary(state, "all", "2026-09-26")
    assert result["debtPaymentSummary"] == {"paidThisMonthCents": 12000, "reversedThisMonthCents": 2000}
    assert result["priorityComparison"] == {
        "reductionCents": 20000,
        "priorityAnnualSavedCents": 4000,
        "largestAnnualSavedCents": None,
    }
    assert result["debtOverview"]["debtCents"] == 60000
    assert result["summary"]["liabilitiesCents"] == 40000


def test_investment_totals_weight_ownership_without_recounting_rewards() -> None:
    state = state_fixture()
    state["accounts"].append(
        {
            "id": "business-sol",
            "entityId": "business",
            "name": "SOL",
            "type": "investment",
            "balanceCents": 90001,
        }
    )
    state["positions"] = [
        {
            "id": "position",
            "accountId": "business-sol",
            "liquidSol": "1.5",
            "stakedSol": "4.5",
            "rewardsSol": "2.0",
            "costBasisCents": 80000,
        }
    ]
    breakdown = summary(state, "all", "2026-09-26")["investmentBreakdown"]
    assert breakdown["solValueCents"] == 45001
    assert breakdown["otherValueCents"] == 50000
    assert breakdown["positions"]["position"] == {
        "totalSol": 6,
        "stakedPercent": 75,
        "valueLessCostCents": 10001,
    }


def test_upcoming_keeps_one_original_arrear_and_clamps_monthly_dates() -> None:
    state = state_fixture()
    state["obligations"] = [{**state["obligations"][0], "dueDate": "2024-01-31", "recurrence": "monthly"}]
    rows = upcoming(state, "me", "2024-02-01", 60)
    assert [row["dueDate"] for row in rows] == ["2024-01-31", "2024-02-29", "2024-03-31"]
    state["obligations"][0]["status"] = "paid"
    assert [row["dueDate"] for row in upcoming(state, "me", "2026-02-01", 60)] == ["2026-02-28", "2026-03-31"]
    state["obligations"][0]["status"] = "cancelled"
    assert upcoming(state, "all", "2026-02-01", 60) == []


@pytest.mark.parametrize("direction", ["in", "out"])
@pytest.mark.parametrize(("recurrence", "anchor", "as_of", "paid", "end", "days"), [
    ("monthly", "2026-01-31", "2026-02-01", "2026-02-28", "2026-03-31", 58),
    ("biweekly", "2026-09-18", "2026-10-03", "2026-10-16", "2026-10-30", 27),
])
def test_upcoming_skips_recorded_projections_without_losing_arrears_or_end_date(
    direction: str, recurrence: str, anchor: str, as_of: str, paid: str, end: str, days: int,
) -> None:
    state = state_fixture()
    state["obligations"] = [{**state["obligations"][0], "direction": direction, "dueDate": anchor, "recurrence": recurrence}]
    state["transactions"] = [{"plannedPayment": {"obligationId": "bill", "dueDate": paid}}]
    before = deepcopy(state)
    assert [row["occurrenceDate"] for row in upcoming(state, "me", as_of, days)] == [anchor, end]
    assert [row["occurrenceDate"] for row in upcoming(state, "me", as_of, days - 1)] == [anchor]
    state["transactions"].append({"plannedPayment": {"obligationId": "bill", "dueDate": end}})
    assert [row["occurrenceDate"] for row in upcoming(state, "me", as_of, days)] == [anchor]
    state["transactions"].pop()
    assert state == before


def test_upcoming_uses_explicit_occurrences_for_paid_anchors_without_inventing_legacy_dates() -> None:
    state = state_fixture()
    state["transactions"] = [
        {"id": "receipt", "date": "2026-10-15", "kind": "expense", "amountCents": 10000,
         "plannedPayment": {"obligationId": "bill", "dueDate": "2026-10-01"}},
        {"id": "refund", "date": "2026-10-16", "kind": "expense", "amountCents": -10000, "refundOf": "receipt"},
        {"id": "legacy", "date": "2026-10-01", "source": "Planned payment business-bill"},
    ]
    assert upcoming(state, "me", "2026-10-01", 0) == []
    assert [row["id"] for row in upcoming(state, "all", "2026-10-01", 0)] == ["business-bill"]


def test_signed_balances_round_symmetrically_and_reject_overflow() -> None:
    assert weighted_cents(101, 5000) == 51
    assert weighted_cents(-101, 5000) == -51
    assert weighted_cents(99999999999947, 5001) == 50009999999973
    state = state_fixture()
    state["accounts"][0]["balanceCents"] = -101
    state["accounts"][2]["balanceCents"] = -1000
    result = recorded_summary(state, "me", "2026-09-26")
    assert result["cashCents"] == -101
    assert result["liabilitiesCents"] == -1000
    state["accounts"][0]["balanceCents"] = MAX_SAFE_CENTS
    with pytest.raises(ValueError, match="supported range"):
        summary(state, "all", "2026-09-26")


def test_full_summary_matches_typescript_fixture_oracle() -> None:
    node = shutil.which("node")
    if not node:
        pytest.skip("Node is required for the TypeScript migration oracle")
    state = state_fixture()
    state["positions"] = [
        {
            "id": "sol",
            "accountId": "investments",
            "liquidSol": "2.125",
            "stakedSol": "3.125",
            "rewardsSol": "1.5",
            "costBasisCents": 52000,
        }
    ]
    cases = [
        {"snapshot": state, "scope": scope, "asOf": "2026-09-26"}
        for scope in ("all", "me", "business", "missing")
    ]
    script = """
import fs from 'node:fs';
import { mock } from 'node:test';
import { engineFixtureResult } from './src/engine-test-fixture.ts';
const cases = JSON.parse(fs.readFileSync(0, 'utf8'));
const results = cases.map(c => {
  mock.timers.enable({apis:['Date'], now: new Date(c.asOf+'T12:00:00Z').getTime()});
  const result = engineFixtureResult(c.snapshot,c.scope,c.asOf,'summary');
  mock.timers.reset();
  return result;
});
process.stdout.write(JSON.stringify(results));
"""
    process = subprocess.run(
        [node, "--experimental-strip-types", "--input-type=module", "-e", script],
        cwd=Path(__file__).resolve().parents[2],
        env={**os.environ, "TZ": "UTC"},
        input=json.dumps(cases),
        text=True,
        capture_output=True,
        check=True,
    )
    assert [summary(case["snapshot"], case["scope"], case["asOf"]) for case in cases] == json.loads(
        process.stdout
    )


@pytest.mark.parametrize("days", [-1, 3661, 1.5, True])
def test_upcoming_rejects_invalid_horizon(days: Any) -> None:
    with pytest.raises(ValueError, match="forecast period"):
        upcoming(state_fixture(), "all", "2026-09-26", days)

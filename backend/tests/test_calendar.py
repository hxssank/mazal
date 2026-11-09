import json
import shutil
import subprocess
from copy import deepcopy
from pathlib import Path
from typing import Any

import pytest

from mazal_engine.calendar import EXPENSE_CATEGORY_TEMPLATES, spending_calendar, statement_coverage
from mazal_engine.debt import MAX_SAFE_CENTS


def fixture() -> dict[str, Any]:
    return {
        "workspace": "demo",
        "revision": 1,
        "entities": [
            {"id": "me", "name": "Personal", "kind": "personal", "ownershipBps": 10000},
            {"id": "business", "name": "Business", "kind": "business", "ownershipBps": 5000},
        ],
        "accounts": [
            {"id": "cash", "entityId": "me", "name": "Cash", "type": "cash", "balanceCents": 10000},
            {
                "id": "business-cash",
                "entityId": "business",
                "name": "Business cash",
                "type": "cash",
                "balanceCents": 20000,
            },
            {"id": "card", "entityId": "me", "name": "Card", "type": "debt", "balanceCents": 30000},
        ],
        "transactions": [],
        "spendingLimits": [],
        "obligations": [],
        "statements": [],
        "importBatches": [],
    }


def expense(id: str, amount: int, category: str = "Food", **changes: Any) -> dict[str, Any]:
    return {
        "id": id,
        "accountId": "cash",
        "date": "2026-09-02",
        "kind": "expense",
        "amountCents": amount,
        "category": category,
        "createdAt": "2026-09-02T12:00:00Z",
        **changes,
    }


def node_result(script: str, input: Any = None) -> Any:
    node = shutil.which("node")
    if not node:
        pytest.skip("Node is required for the TypeScript migration oracle")
    process = subprocess.run(
        [node, "--experimental-strip-types", "--input-type=module", "-e", script],
        cwd=Path(__file__).resolve().parents[2],
        input=json.dumps(input),
        text=True,
        capture_output=True,
        check=True,
    )
    return json.loads(process.stdout)


def test_category_definitions_match_shared_typescript() -> None:
    expected = node_result("""
import {expenseCategoryTemplates} from './shared/expense-categories.ts';
process.stdout.write(JSON.stringify(expenseCategoryTemplates.map(({key,name,label,aliases})=>({key,name,label,aliases}))));
""")
    assert EXPENSE_CATEGORY_TEMPLATES == expected


def test_calendar_signed_cents_future_filter_sort_and_no_mutation() -> None:
    state = fixture()
    state["transactions"] = [
        expense("later", 2000, createdAt="2026-09-03T12:00:00Z"),
        expense("first", 101, accountId="business-cash"),
        expense("refund", -101, accountId="business-cash", date="2026-09-03"),
        expense("future", 9000, date="2026-09-30"),
        expense("not-expense", 9000, kind="debt_payment"),
        expense("missing", 9000, accountId="gone"),
        expense("invalid", 9000, date="2026-09-00"),
    ]
    before = deepcopy(state)
    result = spending_calendar(state, "all", "2026-09-26", "2026-09")
    assert result["data"]["totalCents"] == 2000
    assert result["data"]["transactionCount"] == 3
    assert result["data"]["hasWeightedExpenses"] is True
    assert result["data"]["firstWeekday"] == 1
    assert result["data"]["days"][1]["totalCents"] == 2051
    assert [entry["transaction"]["id"] for entry in result["data"]["days"][1]["entries"]] == [
        "later",
        "first",
    ]
    assert result["data"]["days"][26]["isFuture"] is True
    assert result["summary"]["daysWithExpenses"] == 2
    assert result["summary"]["highestDay"]["date"] == "2026-09-02"
    assert state == before


def test_saved_categories_planned_bills_and_explicit_corrections() -> None:
    state = fixture()
    state["spendingLimits"] = [
        {"id": "me:food", "entityId": "me", "name": "Meals", "aliases": ["Food", "Groceries"]}
    ]
    state["obligations"] = [
        {"id": "phone", "entityId": "me", "direction": "out", "category": "Digital", "subscription": False},
        {
            "id": "streaming",
            "entityId": "me",
            "direction": "out",
            "category": "Digital",
            "subscription": True,
        },
    ]
    state["transactions"] = [
        expense("food", 1000, "Groceries"),
        expense("phone", 2000, "Digital", source="Planned payment phone"),
        expense("streaming", 3000, "Digital", source="Planned payment streaming"),
        expense("corrected", 4000, "Digital", source="Planned payment phone", expenseCategory="Personal"),
        expense("changed", 5000, "Food", source="Planned payment phone"),
        expense("other-owner", 6000, "Digital", accountId="business-cash", source="Planned payment phone"),
    ]
    categories = spending_calendar(state, "all", "2026-09-26", "2026-09")["summary"]["categories"]
    assert categories == [
        {"key": "food", "label": "Meals", "totalCents": 6000},
        {"key": "personal", "label": "Personal care", "totalCents": 4000},
        {"key": "digital", "label": "Digital purchases", "totalCents": 3000},
        {"key": "subscriptions", "label": "Subscriptions", "totalCents": 3000},
        {"key": "bills", "label": "Bills", "totalCents": 2000},
    ]


@pytest.mark.parametrize("changes, expected", [
    ({}, "subscriptions"),
    ({"source": "Planned payment phone"}, "subscriptions"),
    ({"category": "Career"}, "career"),
    ({"expenseCategory": "Digital"}, "digital"),
    ({"expenseCategory": "Uncategorized"}, "other"),
    ({"accountId": "business-cash"}, "digital"),
])
def test_imported_planned_payment_link_preserves_category_overrides(
    changes: dict[str, Any], expected: str,
) -> None:
    state = fixture()
    state["obligations"] = [
        {"id": "phone", "entityId": "me", "direction": "out", "category": "Digital"},
        {"id": "streaming", "entityId": "me", "direction": "out", "category": "Digital", "subscription": True},
    ]
    state["transactions"] = [expense("imported", 1000, **{
        "category": "Digital", "source": "Original bank statement.pdf",
        "plannedPayment": {"obligationId": "streaming", "dueDate": "2026-09-02"}, **changes,
    })]
    before = deepcopy(state)
    categories = spending_calendar(state, "all", "2026-09-26", "2026-09")["summary"]["categories"]
    assert [row["key"] for row in categories] == [expected]
    assert state == before


def test_coverage_unions_committed_periods_without_staged_data() -> None:
    state = fixture()
    state["statements"] = [
        {"accountId": "cash", "periodStart": "2024-02-01", "periodEnd": "2024-02-20"},
        {"accountId": "cash", "periodStart": "2024-02-10", "periodEnd": "2024-02-29"},
    ]
    state["importBatches"] = [
        {
            "status": "committed",
            "source": {"accountId": "card", "periodStart": "2024-02-01", "periodEnd": "2024-02-10"},
        },
        {
            "status": "staged",
            "source": {"accountId": "card", "periodStart": "2024-02-01", "periodEnd": "2024-02-29"},
        },
    ]
    result = statement_coverage(state, "me", "2024-02")
    assert result == {
        "status": "partial",
        "accountCount": 2,
        "coveredAccountCount": 2,
        "completeAccountCount": 1,
        "coveredAccountDays": 39,
        "totalAccountDays": 58,
        "accounts": [
            {"accountId": "cash", "coveredDays": 29, "totalDays": 29},
            {"accountId": "card", "coveredDays": 10, "totalDays": 29},
        ],
    }
    assert statement_coverage(state, "me", "2024-02", "cash")["status"] == "complete"
    assert statement_coverage(state, "missing", "2024-02")["status"] == "none"


def test_refund_only_month_has_no_positive_highest_day() -> None:
    state = fixture()
    state["transactions"] = [expense("refund", -1500)]
    result = spending_calendar(state, "me", "2026-09-26", "2026-09")
    assert result["summary"]["highestDay"] is None
    assert result["data"]["largestDayCents"] == 0
    assert result["summary"]["categories"][0]["totalCents"] == -1500


def test_all_categories_and_saved_aliases_match_typescript_oracle() -> None:
    states = []
    state = fixture()
    for template in EXPENSE_CATEGORY_TEMPLATES:
        for category in [template["name"], template["label"], *template["aliases"]]:
            count = len(state["transactions"])
            state["transactions"].append(
                expense(
                    f"entry-{count:03}",
                    count * 101,
                    category,
                    accountId="cash" if count % 2 else "business-cash",
                )
            )
    states.append(state)
    custom = fixture()
    custom["spendingLimits"] = [
        {"id": "custom", "entityId": "me", "name": "Ｃａｆｅ", "aliases": ["Food", "Caffeine"]},
        {"id": "business-custom", "entityId": "business", "name": "Cafe", "aliases": ["Caffeine"]},
        {"id": "me:personal", "entityId": "me", "name": "Health", "aliases": []},
        {"id": "exercise", "entityId": "me", "name": "Exercise", "aliases": ["gym"]},
    ]
    custom["transactions"] = [
        expense("custom", 300, "Caffeine"),
        expense("business", 300, "Caffeine", accountId="business-cash"),
        expense("food", 500, "Food & groceries"),
        expense("gym", 600, "gym"),
        expense("health", 700, "medical"),
        expense("refund", -101, "Caffeine", accountId="business-cash"),
        expense("large", 99999999999947, "Uncategorized", accountId="business-cash"),
    ]
    custom["entities"][1]["ownershipBps"] = 5001
    states.append(custom)
    planned = fixture()
    planned["obligations"] = [
        {"id": "phone", "entityId": "me", "direction": "out", "category": "Digital", "subscription": False},
        {
            "id": "subscription",
            "entityId": "me",
            "direction": "out",
            "category": "Uncategorized",
            "subscription": True,
        },
    ]
    planned["transactions"] = [
        expense("phone", 3000, "Digital", source="Planned payment phone"),
        expense("subscription", 2000, "", source="Planned payment subscription"),
        expense("corrected", 2000, "Digital", source="Planned payment phone", expenseCategory=""),
        expense("otherowner", 2000, "Digital", source="Planned payment phone", accountId="business-cash"),
        expense("linked-phone", 3100, "Digital", source="Original bank statement.pdf",
                plannedPayment={"obligationId": "phone", "dueDate": "2026-09-02"}),
        expense("linked-subscription", 2100, "Uncategorized", source="Original bank statement.pdf",
                plannedPayment={"obligationId": "subscription", "dueDate": "2026-09-02"}),
        expense("linked-corrected", 2200, "Digital", source="Original bank statement.pdf", expenseCategory="Career",
                plannedPayment={"obligationId": "phone", "dueDate": "2026-09-02"}),
        expense("linked-other-owner", 2300, "Digital", source="Original bank statement.pdf", accountId="business-cash",
                plannedPayment={"obligationId": "phone", "dueDate": "2026-09-02"}),
    ]
    planned["statements"] = [{"accountId": "cash", "periodStart": "2026-09-01", "periodEnd": "2026-09-15"}]
    planned["importBatches"] = [
        {
            "status": "committed",
            "source": {"accountId": "cash", "periodStart": "2026-09-10", "periodEnd": "2026-09-30"},
        },
        {
            "status": "staged",
            "source": {"accountId": "card", "periodStart": "2026-09-01", "periodEnd": "2026-09-30"},
        },
    ]
    states.append(planned)
    cases = [
        {"state": state, "scope": scope} for state in states for scope in ("all", "me", "business", "missing")
    ]
    oracle = node_result(
        """
import fs from 'node:fs';
import {spendingCalendar,summarizeSpendingMonth} from './shared/spending-calendar.ts';
import {statementCoverage} from './shared/statement-imports.ts';
const cases=JSON.parse(fs.readFileSync(0,'utf8'));
process.stdout.write(JSON.stringify(cases.map(({state,scope})=>{
 const data=spendingCalendar(state,scope,'2026-09','2026-09-26');
 return {data,summary:summarizeSpendingMonth(state,data),coverage:statementCoverage(state,scope,'2026-09')};
})));
""",
        cases,
    )
    assert [
        spending_calendar(case["state"], case["scope"], "2026-09-26", "2026-09") for case in cases
    ] == oracle


def test_calendar_rejects_unsafe_totals() -> None:
    state = fixture()
    state["transactions"] = [expense("max", MAX_SAFE_CENTS), expense("overflow", 1)]
    with pytest.raises(ValueError, match="supported range"):
        spending_calendar(state, "me", "2026-09-26", "2026-09")


@pytest.mark.parametrize("month", ["2026-13", "2026-1", "2026-00", "invalid"])
def test_calendar_rejects_invalid_month(month: str) -> None:
    with pytest.raises(ValueError):
        spending_calendar(fixture(), "me", "2026-09-26", month)

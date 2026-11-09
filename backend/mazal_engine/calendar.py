from __future__ import annotations

import calendar
from collections.abc import Callable
from copy import deepcopy
from datetime import timedelta
from typing import Any

from .dates import month_start, next_month, parse_date
from .summary import add_cents, normalized_category, weighted_cents

_HEALTH_ALIASES = [
    "gym",
    "gym membership",
    "fitness",
    "health & fitness",
    "supplements",
    "health",
    "medication",
    "pharmacy",
    "dental",
    "medical",
]
_TEMPLATE_ROWS = [
    ("housing", "Housing", "Housing & family", ["housing", "rent", "family", "family support"]),
    (
        "bills",
        "Bills",
        "Bills",
        [
            "bills",
            "utilities",
            "electricity",
            "water",
            "tenant insurance",
            "phone",
            "mobile",
            "internet",
            "broadband",
        ],
    ),
    ("food", "Food", "Food & groceries", ["groceries", "food & drink", "dining", "restaurants", "coffee"]),
    (
        "transport",
        "Transport",
        "Transport",
        [
            "transportation",
            "gas",
            "fuel",
            "fuel & convenience",
            "parking",
            "transit",
            "car",
            "car insurance",
            "auto insurance",
            "car maintenance",
            "rideshare",
        ],
    ),
    (
        "personal",
        "Personal",
        "Personal care",
        [
            "personal",
            "clothing",
            "clothes",
            "toiletries",
            "haircut",
            "haircuts",
            "grooming",
            "gifts",
            *_HEALTH_ALIASES,
        ],
    ),
    (
        "subscriptions",
        "Subscriptions",
        "Subscriptions",
        ["subscriptions", "subscription", "streaming", "apps", "membership", "memberships"],
    ),
    (
        "digital",
        "Digital",
        "Digital purchases",
        ["digital purchase", "digital purchases", "software", "games"],
    ),
    (
        "career",
        "Career",
        "Career & learning",
        ["career", "learning", "education", "courses", "books", "exams", "work tools"],
    ),
    ("social", "Social", "Social", ["social", "entertainment", "events", "movies", "concerts", "going out"]),
    (
        "trips",
        "Trips",
        "Trips",
        ["travel", "trips", "vacation", "holidays", "flights", "hotels", "accommodation"],
    ),
    (
        "sidequests",
        "Side quests",
        "Side quests",
        ["side quest", "side quests", "hobby", "hobbies", "projects"],
    ),
    (
        "fees",
        "Fees & interest",
        "Fees & interest",
        ["interest", "bank fees", "fees", "service charges", "finance charges"],
    ),
    ("cannabis", "Goy", "Goy", ["cannabis & vape", "cannabis", "vape", "vaping"]),
    ("other", "Other", "Other", ["uncategorized"]),
]
EXPENSE_CATEGORY_TEMPLATES = [
    {"key": key, "name": name, "label": label, "aliases": aliases}
    for key, name, label, aliases in _TEMPLATE_ROWS
]


def category_template_for(limit: dict[str, Any]) -> dict[str, Any] | None:
    return next(
        (
            template
            for template in EXPENSE_CATEGORY_TEMPLATES
            if limit["id"] == f"{limit['entityId']}:{template['key']}"
        ),
        None,
    ) or next(
        (
            template
            for template in EXPENSE_CATEGORY_TEMPLATES
            if normalized_category(template["name"]) == normalized_category(limit["name"])
        ),
        None,
    )


def category_limits(snapshot: dict[str, Any], owner: str) -> list[dict[str, Any]]:
    saved = [limit for limit in snapshot.get("spendingLimits", []) if limit["entityId"] == owner]
    limits = deepcopy(saved)
    claimed = {
        normalized_category(alias) for limit in limits for alias in [limit["name"], *limit.get("aliases", [])]
    }
    personal = next(
        (limit for limit in limits if (category_template_for(limit) or {}).get("key") == "personal"), None
    )
    if personal:
        for alias in _HEALTH_ALIASES:
            key = normalized_category(alias)
            if key not in claimed:
                personal.setdefault("aliases", []).append(alias)
                claimed.add(key)
    for template in EXPENSE_CATEGORY_TEMPLATES:
        if any(
            limit["id"] == f"{owner}:{template['key']}"
            or normalized_category(limit["name"]) == normalized_category(template["name"])
            for limit in saved
        ):
            continue
        name = template["name"]
        if normalized_category(name) in claimed:
            name = template["label"]
            suffix = 2
            while normalized_category(name) in claimed:
                name = f"{template['label']} {suffix}"
                suffix += 1
        seen = {normalized_category(name)}
        aliases = []
        for alias in [*template["aliases"], template["label"]]:
            key = normalized_category(alias)
            if key not in claimed and key not in seen:
                seen.add(key)
                aliases.append(alias)
        limits.append(
            {"id": f"{owner}:{template['key']}", "entityId": owner, "name": name, "aliases": aliases}
        )
        claimed.update(normalized_category(alias) for alias in [name, *aliases])

    def order(limit: dict[str, Any]) -> tuple[float, str]:
        template = category_template_for(limit)
        return (
            EXPENSE_CATEGORY_TEMPLATES.index(template) if template else len(EXPENSE_CATEGORY_TEMPLATES) - 1.5,
            limit["name"],
        )

    return sorted(limits, key=order)


def transaction_category_matcher(
    snapshot: dict[str, Any], owner: str, limits: list[dict[str, Any]]
) -> Callable[[dict[str, Any]], dict[str, Any]]:
    saved_ids = {limit["id"] for limit in snapshot.get("spendingLimits", [])}
    fallback = next(
        limit
        for limit in limits
        if normalized_category(limit["name"]) == "other" or limit["id"] == f"{limit['entityId']}:other"
    )
    by_alias: dict[str, dict[str, Any]] = {}
    for limit in sorted(limits, key=lambda item: item["id"] not in saved_ids):
        if limit is fallback:
            continue
        for alias in [limit["name"], *limit.get("aliases", [])]:
            by_alias.setdefault(normalized_category(alias), limit)

    def category(value: str) -> dict[str, Any]:
        return by_alias.get(normalized_category(value), fallback)

    sources = {}
    for obligation in snapshot.get("obligations", []):
        if obligation["entityId"] != owner or obligation["direction"] != "out":
            continue
        original = category(obligation.get("category", ""))
        template = category_template_for(original)
        key = (
            "subscriptions"
            if obligation.get("subscription")
            else "bills"
            if template and template["key"] in ("digital", "other")
            else None
        )
        selected = (
            next(
                (limit for limit in limits if (category_template_for(limit) or {}).get("key") == key),
                original,
            )
            if key
            else original
        )
        sources[f"Planned payment {obligation['id']}"] = (selected, obligation.get("category", ""))

    def match(transaction: dict[str, Any]) -> dict[str, Any]:
        if "expenseCategory" in transaction:
            return category(transaction["expenseCategory"])
        payment = transaction.get("plannedPayment")
        planned = sources.get(f"Planned payment {payment['obligationId']}" if isinstance(payment, dict)
                              else transaction.get("source"))
        label = normalized_category(transaction.get("category", ""))
        if planned:
            planned_label = normalized_category(planned[1])
            if (
                label == planned_label
                or label in ("", "uncategorized")
                and planned_label in ("", "uncategorized")
            ):
                return planned[0]
        return category(transaction.get("category", ""))

    return match


def statement_coverage(
    snapshot: dict[str, Any], scope: str, month: str, account_id: str = "all"
) -> dict[str, Any]:
    first = month_start(month)
    total_days = calendar.monthrange(first.year, first.month)[1]
    dates = [(first + timedelta(days=offset)).isoformat() for offset in range(total_days)]
    accounts = [
        account
        for account in snapshot.get("accounts", [])
        if account["type"] in ("cash", "debt", "payable")
        and (scope == "all" or account["entityId"] == scope)
        and (account_id == "all" or account["id"] == account_id)
        and (not account.get("closedAt") or account["closedAt"] >= dates[0])
    ]
    periods = [
        *snapshot.get("statements", []),
        *(batch["source"] for batch in snapshot.get("importBatches", []) if batch["status"] == "committed"),
    ]
    rows = []
    for account in accounts:
        matching = [period for period in periods if period["accountId"] == account["id"]]
        active_dates = [day for day in dates if not account.get("closedAt") or day <= account["closedAt"]]
        rows.append(
            {
                "accountId": account["id"],
                "coveredDays": sum(
                    any(period["periodStart"] <= day <= period["periodEnd"] for period in matching)
                    for day in active_dates
                ),
                "totalDays": len(active_dates),
            }
        )
    covered = sum(row["coveredDays"] for row in rows)
    total = sum(row["totalDays"] for row in rows)
    return {
        "status": "none" if covered == 0 else "complete" if covered == total else "partial",
        "accountCount": len(rows),
        "coveredAccountCount": sum(row["coveredDays"] > 0 for row in rows),
        "completeAccountCount": sum(row["coveredDays"] == row["totalDays"] for row in rows),
        "coveredAccountDays": covered,
        "totalAccountDays": total,
        "accounts": rows,
    }


def summarize_spending_month(snapshot: dict[str, Any], data: dict[str, Any]) -> dict[str, Any]:
    accounts = {account["id"]: account for account in snapshot.get("accounts", [])}
    saved_ids = {limit["id"] for limit in snapshot.get("spendingLimits", [])}
    matchers = {}
    categories: dict[str, dict[str, Any]] = {}
    days_with_expenses = 0
    highest = None
    for day in data["days"]:
        days_with_expenses += bool(day["entries"])
        if day["totalCents"] > (highest["totalCents"] if highest else 0):
            highest = day
        for entry in day["entries"]:
            owner = accounts.get(entry["transaction"]["accountId"], {}).get("entityId", "")
            if owner not in matchers:
                matchers[owner] = transaction_category_matcher(
                    snapshot, owner, category_limits(snapshot, owner)
                )
            limit = matchers[owner](entry["transaction"])
            template = category_template_for(limit)
            saved_name = (
                limit["id"] in saved_ids
                and template
                and normalized_category(limit["name"])
                not in (normalized_category(template["name"]), normalized_category(template["label"]))
            )
            label = limit["name"] if saved_name or not template else template["label"]
            key = template["key"] if template else f"custom:{normalized_category(label)}"
            category = categories.setdefault(key, {"key": key, "label": label, "totalCents": 0})
            category["totalCents"] = add_cents(category["totalCents"], entry["amountCents"])
    return {
        "categories": sorted(categories.values(), key=lambda row: (-row["totalCents"], row["label"])),
        "daysWithExpenses": days_with_expenses,
        "highestDay": deepcopy(highest),
    }


def spending_calendar(snapshot: dict[str, Any], scope: str, as_of: str, month: str) -> dict[str, Any]:
    first = month_start(month)
    parse_date(as_of, "As-of date")
    days = [
        {"date": day.isoformat(), "totalCents": 0, "entries": [], "isFuture": day.isoformat() > as_of}
        for day in (first + timedelta(days=offset) for offset in range((next_month(first) - first).days))
    ]
    by_date = {day["date"]: day for day in days}
    accounts = {account["id"]: account for account in snapshot.get("accounts", [])}
    owners = {owner["id"]: owner for owner in snapshot.get("entities", [])}
    total = count = 0
    weighted = False
    for transaction in snapshot.get("transactions", []):
        if (
            transaction["kind"] != "expense"
            or transaction["date"][:7] != month
            or transaction["date"] > as_of
        ):
            continue
        account = accounts.get(transaction["accountId"])
        if not account or scope != "all" and account["entityId"] != scope:
            continue
        day = by_date.get(transaction["date"])
        if day is None:
            continue
        owner = owners.get(account["entityId"], {})
        ownership = owner.get("ownershipBps", 0) if scope == "all" else 10000
        amount = weighted_cents(transaction["amountCents"], ownership)
        day["entries"].append(
            {
                "transaction": deepcopy(transaction),
                "amountCents": amount,
                "recordedAmountCents": transaction["amountCents"],
                "accountName": account["name"],
                "ownerName": owner.get("name", ""),
                "ownershipBps": ownership,
            }
        )
        day["totalCents"] = add_cents(day["totalCents"], amount)
        total = add_cents(total, amount)
        count += 1
        weighted = weighted or ownership != 10000
    for day in days:
        day["entries"].sort(key=lambda entry: entry["transaction"]["id"])
        day["entries"].sort(key=lambda entry: entry["transaction"].get("createdAt", ""), reverse=True)
    data = {
        "month": month,
        "firstWeekday": first.weekday(),
        "days": days,
        "totalCents": total,
        "transactionCount": count,
        "largestDayCents": max(0, *(day["totalCents"] for day in days)),
        "hasWeightedExpenses": weighted,
    }
    return {
        "data": data,
        "summary": summarize_spending_month(snapshot, data),
        "coverage": statement_coverage(snapshot, scope, month),
    }

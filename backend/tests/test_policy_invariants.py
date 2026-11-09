from mazal_engine.allocation import _calendar, _prepare, _simulate


def test_policies_make_identical_decisions_before_unannounced_shock():
    snapshot = {
        "entities": [{"id": "me", "kind": "personal"}],
        "accounts": [
            {"id": "cash", "entityId": "me", "type": "cash", "balanceCents": 100_000},
            {"id": "invest", "entityId": "me", "type": "investment", "balanceCents": 20_000},
        ],
    }
    assumptions = {
        "months": 4, "payCents": 100_000, "frequency": 26, "paydayAnchor": "2026-01-01",
        "monthlySpendingCents": 50_000, "reserveCents": 10_000, "annualReturnPercent": 5,
    }
    prepared, missing, _warnings = _prepare(snapshot, "all", "2026-01-01", assumptions)
    assert not missing
    schedule = _calendar(snapshot, prepared)
    ordinary = {"shockPercent": 0, "shockMonth": 3}
    surprise = {"shockPercent": -100, "shockMonth": 3, "unexpectedExpenseCents": 300_000}
    for share in [None, 0, 0.25, 0.5, 1]:
        baseline = _simulate(snapshot, prepared, schedule, share, ordinary)
        stressed = _simulate(snapshot, prepared, schedule, share, surprise)
        assert [row for row in baseline["weekly"] if row["endDate"] < "2026-03-01"] == [
            row for row in stressed["weekly"] if row["endDate"] < "2026-03-01"
        ]
        assert stressed["netWorthCents"] < baseline["netWorthCents"]

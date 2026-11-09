from __future__ import annotations

from copy import deepcopy
from typing import Any

import pytest
from pydantic import ValidationError

from mazal_engine.models import EngineRequest, envelope


def request_data() -> dict[str, Any]:
    return {
        "snapshot": {
            "workspace": "live",
            "revision": 9,
            "entities": [{"id": "personal", "name": "Personal", "kind": "personal", "ownershipBps": 10000}],
            "accounts": [
                {
                    "id": "cash", "entityId": "personal", "name": "Cash", "type": "cash",
                    "currency": "CAD", "balanceCents": 100_000, "reconciledAt": "2026-01-01",
                }
            ],
            "transactions": [
                {
                    "id": "expense", "accountId": "cash", "toAccountId": None, "date": "2026-01-01",
                    "kind": "expense", "amountCents": 1000, "category": "Food", "source": "Manual entry",
                }
            ],
            "obligations": [], "reserves": [], "positions": [], "lastBackupAt": None,
        },
        "scope": "personal",
        "asOf": "2026-01-02",
        "kind": "planner",
        "draft": {"pay": "1000", "debts": {}},
        "assumptions": {"seed": 42, "nested": {"annualReturnPercent": 0}},
    }


@pytest.mark.parametrize("value", [True, False, 1.0, "1000", None, 2**53, -(2**53)])
@pytest.mark.parametrize("field", ["balanceCents", "amountCents"])
def test_money_requires_exact_json_integer_cents(field: str, value: Any) -> None:
    raw = request_data()
    collection = "accounts" if field == "balanceCents" else "transactions"
    raw["snapshot"][collection][0][field] = value
    with pytest.raises(ValidationError):
        EngineRequest.model_validate(raw)


def test_signed_account_balances_and_signed_refunds_remain_exact() -> None:
    raw = request_data()
    raw["snapshot"]["accounts"][0]["balanceCents"] = -500
    raw["snapshot"]["transactions"][0]["amountCents"] = -100
    request = EngineRequest.model_validate(raw)
    assert request.snapshot.accounts[0].balanceCents == -500
    assert request.snapshot.transactions[0].amountCents == -100


@pytest.mark.parametrize("kind", ["opening", "adjustment"])
def test_signed_balance_records_do_not_require_manual_reversal_links(kind: str) -> None:
    raw = request_data()
    raw["snapshot"]["transactions"][0].update(kind=kind, amountCents=-100)
    assert EngineRequest.model_validate(raw).snapshot.transactions[0].amountCents == -100


def test_refund_with_broken_original_account_is_a_validation_error() -> None:
    raw = request_data()
    original = raw["snapshot"]["transactions"][0]
    refund = {**original, "id": "refund", "amountCents": -100, "refundOf": original["id"]}
    original["accountId"] = "missing"
    raw["snapshot"]["transactions"].insert(0, refund)
    with pytest.raises(ValidationError, match="refund"):
        EngineRequest.model_validate(raw)


@pytest.mark.parametrize("collection", ["entities", "accounts", "transactions"])
def test_duplicate_record_identifiers_are_rejected(collection: str) -> None:
    raw = request_data()
    raw["snapshot"][collection].append(deepcopy(raw["snapshot"][collection][0]))
    with pytest.raises(ValidationError, match="unique"):
        EngineRequest.model_validate(raw)


@pytest.mark.parametrize("reference", ["entityId", "accountId", "toAccountId"])
def test_broken_owner_and_account_references_are_rejected(reference: str) -> None:
    raw = request_data()
    collection = "accounts" if reference == "entityId" else "transactions"
    raw["snapshot"][collection][0][reference] = "missing"
    with pytest.raises(ValidationError, match="recorded"):
        EngineRequest.model_validate(raw)


@pytest.mark.parametrize("scope", ["", "missing", "x" * 201])
def test_scope_must_resolve_to_saved_entities(scope: str) -> None:
    raw = request_data()
    raw["scope"] = scope
    with pytest.raises(ValidationError):
        EngineRequest.model_validate(raw)


@pytest.mark.parametrize("value", [True, 9.0, "9", -1])
def test_revision_is_a_nonnegative_integer(value: Any) -> None:
    raw = request_data()
    raw["snapshot"]["revision"] = value
    with pytest.raises(ValidationError):
        EngineRequest.model_validate(raw)


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
@pytest.mark.parametrize("location", ["assumptions", "draft", "snapshot"])
def test_nonfinite_nested_inputs_are_rejected(location: str, value: float) -> None:
    raw = request_data()
    raw[location]["extra"] = {"nested": [value]}
    with pytest.raises(ValidationError):
        EngineRequest.model_validate(raw)


@pytest.mark.parametrize("value", ["2026-02-30", "20260102", "2026-01-02T00:00:00Z", "1899-01-01"])
def test_as_of_requires_a_supported_calendar_date(value: str) -> None:
    raw = request_data()
    raw["asOf"] = value
    with pytest.raises(ValidationError):
        EngineRequest.model_validate(raw)


def test_envelope_hash_is_canonical_and_changes_with_revision_or_draft() -> None:
    raw = request_data()
    first = envelope(EngineRequest.model_validate(raw), {"amount": 1})
    reordered = dict(reversed(list(raw.items())))
    reordered["snapshot"] = dict(reversed(list(raw["snapshot"].items())))
    same = envelope(EngineRequest.model_validate(reordered), {"amount": 999})
    assert same["inputHash"] == first["inputHash"]
    revised = deepcopy(raw)
    revised["snapshot"]["revision"] += 1
    assert envelope(EngineRequest.model_validate(revised), {})["inputHash"] != first["inputHash"]
    changed = deepcopy(raw)
    changed["draft"]["pay"] = "2000"
    assert envelope(EngineRequest.model_validate(changed), {})["inputHash"] != first["inputHash"]
    assert len(first["inputHash"]) == 64
    assert first["workspace"] == "live"
    assert first["scope"] == "personal"
    assert first["revision"] == 9
    assert first["asOf"] == "2026-01-02"
    assert all(first["dependencies"].values())


def test_validation_and_serialization_do_not_mutate_caller_snapshot() -> None:
    raw = request_data()
    before = deepcopy(raw)
    request = EngineRequest.model_validate(raw)
    serialized = request.model_dump()
    serialized["snapshot"]["accounts"][0]["balanceCents"] = 0
    serialized["draft"]["debts"]["invented"] = {"minimum": "100"}
    serialized["assumptions"]["nested"]["annualReturnPercent"] = 100
    envelope(request, {"status": "checked"})
    assert raw == before
    assert request.snapshot.accounts[0].balanceCents == 100_000
    assert request.draft["debts"] == {}
    assert request.assumptions["nested"]["annualReturnPercent"] == 0


@pytest.mark.parametrize(
    "assumptions",
    [
        {"payCents": 100.5}, {"reserveCents": True}, {"monthlySpendingCents": "100"},
        {"frequency": True}, {"seed": True}, {"months": True}, {"months": 0},
        {"annualReturnPercent": True}, {"userInvestmentShare": True},
        {"userInvestmentShare": 1.01}, {"shcokPercent": -30},
        {"incomeChanges": [{"date": "2026-06-01", "monthlyIncomeCents": 100.5}]},
    ],
)
def test_funding_assumptions_reject_coercion_and_misspelled_fields(assumptions: dict[str, Any]) -> None:
    raw = request_data()
    raw.update(kind="comparison", assumptions=assumptions)
    with pytest.raises(ValidationError):
        EngineRequest.model_validate(raw)


@pytest.mark.parametrize("kind", ["comparison", "spending"])
def test_validated_assumptions_keep_missing_inputs_missing(kind: str) -> None:
    raw = request_data()
    raw.update(kind=kind, assumptions={})
    request = EngineRequest.model_validate(raw)
    assert request.assumptions == {}
    assert raw["assumptions"] == {}


def test_spending_assumptions_reject_unknown_options() -> None:
    raw = request_data()
    raw.update(kind="spending", assumptions={"seed": 42, "pretendMissingWeeksAreZero": True})
    with pytest.raises(ValidationError):
        EngineRequest.model_validate(raw)


@pytest.mark.parametrize("contribution_kind", ["payment", "repair"])
def test_actual_store_purchase_contributions_preserve_engine_contract(tmp_path, contribution_kind: str) -> None:
    import json
    import shutil
    import subprocess
    from pathlib import Path

    node = shutil.which("node")
    if node is None:
        pytest.skip("Node is required for store-to-engine integration checks.")
    script = f"""
import {{createStore}} from './server/store.ts';
const store=createStore({json.dumps(str(tmp_path / 'live.sqlite'))},'live');
try {{
  store.command({{type:'add_account',entityId:'personal',name:'Test bank',accountType:'cash',openingBalanceCents:100000,openingDate:'2026-01-01'}});
  const accountId=store.state().accounts[0].id;
  store.command({{type:'add_account',entityId:'personal',name:'Test portfolio',accountType:'investment',openingBalanceCents:0,openingDate:'2026-01-01'}});
  const toAccountId=store.state().accounts.find(row=>row.type==='investment').id;
  store.command({{type:'add_transaction',kind:'transfer',accountId,toAccountId,amountCents:1000,date:'2026-01-02',description:'Portfolio contribution',category:'Investments',requestId:'portfolio'}});
  const before=store.state();
  const purchase={{id:'test-car',entityId:'personal',name:'Test car',payee:'Seller',targetCents:200000,monthlyCents:10000,paidCents:0,paidAsOf:'2026-01-01',notes:''}};
  store.command({{type:'save_asset_purchase',purchase,expected:null,requestId:'purchase'}});
  store.command({{type:'record_asset_purchase_payment',id:purchase.id,expected:purchase,accountId,amountCents:10000,date:'2026-01-02',notes:'',contributionKind:{json.dumps(contribution_kind)},requestId:'payment'}});
  process.stdout.write(JSON.stringify([before,store.state()]));
}} finally {{store.close();}}
"""
    output = subprocess.run([node, "--input-type=module", "-"], input=script, text=True,
                            cwd=Path(__file__).parents[2], capture_output=True, check=True, timeout=30)
    before, after = json.loads(output.stdout)
    for snapshot in (before, after):
        request = EngineRequest.model_validate({"snapshot": snapshot, "scope": "personal", "asOf": "2026-01-03", "kind": "daily_plan"})
        assert request.snapshot.transactions
    assert any(row["toAccountId"] == "asset-purchase:test-car" for row in after["transactions"])


@pytest.mark.parametrize("kind", ["expense", "income", "debt_payment"])
def test_actual_store_refunds_and_corrections_preserve_signed_engine_contract(tmp_path, kind: str) -> None:
    import json
    import shutil
    import subprocess
    from pathlib import Path

    from mazal_engine.dated_events import payday_receipt
    from mazal_engine.summary import debt_payments_since_statement

    node = shutil.which("node")
    if node is None:
        pytest.skip("Node is required for store-to-engine integration checks.")
    script = f"""
import {{createStore}} from './server/store.ts';
const store=createStore({json.dumps(str(tmp_path / 'live.sqlite'))},'live');
const command=payload=>store.command({{...payload,expectedRevision:store.state().revision}});
const kind={json.dumps(kind)};
try {{
  command({{type:'add_account',entityId:'personal',name:'Test bank',accountType:'cash',openingBalanceCents:100000,openingDate:'2026-01-01'}});
  const accountId=store.state().accounts[0].id;
  command({{type:'add_account',entityId:'personal',name:'Test loan',accountType:'debt',openingBalanceCents:10000,openingDate:'2026-01-01'}});
  const debtId=store.state().accounts.find(row=>row.type==='debt').id;
  command({{type:'set_debt_terms',accountId:debtId,terms:{{aprPercent:0,rateConfirmed:true,minimumPaymentCents:100,notes:'',statementDate:'2026-01-01',paymentDueDate:'2026-01-31'}}}});
  const transfer=kind==='debt_payment'?{{toAccountId:debtId}}:{{}};
  command({{type:'add_transaction',kind,accountId,...transfer,amountCents:1000,date:'2026-01-02',description:'Original',category:'Reviewed',...(kind==='income'?{{paydayDate:'2026-01-02'}}:{{}}),requestId:'original'}});
  const original=store.state().transactions.find(row=>row.description==='Original');
  command({{type:'correct_transaction',id:original.id,reason:'Corrected source amount',replacement:{{kind,accountId,...transfer,amountCents:400,date:'2026-01-02',description:'Replacement',category:'Reviewed'}},requestId:'correct'}});
  if(kind==='income') {{
    command({{type:'add_transaction',kind,accountId,amountCents:1000,date:'2026-01-03',paydayDate:'2026-01-03',description:'Income to reverse',category:'Reviewed',requestId:'reverse-income'}});
    const receipt=store.state().transactions.find(row=>row.description==='Income to reverse');
    command({{type:'correct_transaction',id:receipt.id,reason:'Deposit entered twice',requestId:'reverse-receipt'}});
  }}
  if(kind==='expense') {{
    command({{type:'add_transaction',kind,accountId,amountCents:1000,date:'2026-01-02',description:'Refunded purchase',category:'Reviewed',requestId:'purchase'}});
    const purchase=store.state().transactions.find(row=>row.description==='Refunded purchase');
    command({{type:'record_refund',id:purchase.id,accountId,amountCents:200,date:'2026-01-03',reason:'Partial refund',requestId:'refund'}});
  }}
  process.stdout.write(JSON.stringify(store.state()));
}} finally {{store.close();}}
"""
    output = subprocess.run([node, "--input-type=module", "-"], input=script, text=True,
                            cwd=Path(__file__).parents[2], capture_output=True, check=True, timeout=30)
    snapshot = json.loads(output.stdout)
    request = EngineRequest.model_validate({"snapshot": snapshot, "scope": "personal", "asOf": "2026-01-03", "kind": "daily_plan"})
    original = next(row for row in snapshot["transactions"] if row["description"] == "Original")
    assert any(row.get("reversalOf") == original["id"] and row["amountCents"] == -1000 for row in snapshot["transactions"])
    assert any(row.get("replacesId") == original["id"] and row["amountCents"] == 400 for row in snapshot["transactions"])
    assert request.snapshot.revision == snapshot["revision"]
    if kind == "debt_payment":
        debt = next(row for row in snapshot["accounts"] if row["type"] == "debt")
        assert debt_payments_since_statement(snapshot, debt, "2026-01-03") == 400
        assert debt["balanceCents"] == 9600
    elif kind == "income":
        receipt = payday_receipt(snapshot, "personal", "2026-01-02")
        assert receipt is not None and receipt["description"] == "Replacement" and receipt["amountCents"] == 400
        assert payday_receipt(snapshot, "personal", "2026-01-03") is None
    else:
        assert sum(row["amountCents"] for row in snapshot["transactions"] if row["kind"] == "expense") == 1200


@pytest.mark.parametrize("change", ["owner", "kind", "missing", "duplicate"])
def test_purchase_destination_requires_exact_record_owner_and_transfer(change: str) -> None:
    raw = request_data()
    raw["snapshot"]["assetPurchases"] = [{"id": "car", "entityId": "personal"}]
    row = raw["snapshot"]["transactions"][0]
    row.update(kind="transfer", toAccountId="asset-purchase:car")
    EngineRequest.model_validate(raw)
    if change == "owner":
        raw["snapshot"]["assetPurchases"][0]["entityId"] = "missing"
    elif change == "kind":
        row["kind"] = "expense"
    elif change == "duplicate":
        raw["snapshot"]["assetPurchases"].append(deepcopy(raw["snapshot"]["assetPurchases"][0]))
    else:
        row["toAccountId"] = "asset-purchase:missing"
    with pytest.raises(ValidationError, match="Purchase|purchase"):
        EngineRequest.model_validate(raw)


@pytest.mark.parametrize("kind", ["income", "expense", "transfer", "debt_payment"])
def test_explicit_reversal_preserves_signed_transaction_contract(kind: str) -> None:
    raw = request_data()
    original = raw["snapshot"]["transactions"][0]
    original["kind"] = kind
    reversal = {**original, "id": "reversal", "amountCents": -original["amountCents"], "reversalOf": original["id"]}
    raw["snapshot"]["transactions"].append(reversal)
    EngineRequest.model_validate(raw)
    reversal["amountCents"] -= 1
    with pytest.raises(ValidationError, match="reversal"):
        EngineRequest.model_validate(raw)


def test_imported_planned_payment_uses_explicit_relationship_without_changing_source() -> None:
    raw = request_data()
    raw["snapshot"]["obligations"] = [{"id": "rent", "entityId": "personal", "direction": "out"}]
    row = raw["snapshot"]["transactions"][0]
    row.update(source="Original bank statement.pdf", plannedPayment={"obligationId": "rent", "dueDate": "2026-01-01"})
    validated = EngineRequest.model_validate(raw).snapshot.model_dump()["transactions"][0]
    assert validated["source"] == row["source"]
    assert validated["plannedPayment"] == row["plannedPayment"]
    raw["snapshot"]["obligations"][0]["entityId"] = "another-owner"
    with pytest.raises(ValidationError, match="planned payment"):
        EngineRequest.model_validate(raw)

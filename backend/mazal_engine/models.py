from __future__ import annotations

import hashlib
import json
from datetime import date
from functools import lru_cache
from importlib.metadata import version
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from . import MODEL_VERSION

Cents = Annotated[int, Field(strict=True, ge=-(2**53 - 1), le=2**53 - 1)]
NonnegativeCents = Annotated[int, Field(strict=True, ge=0, le=2**53 - 1)]
ScenarioCents = Annotated[int, Field(strict=True, ge=0, le=10**12)]
Seed = Annotated[int, Field(strict=True, ge=0, le=2**32 - 1)]


class ModelInputs(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class IncomeChange(ModelInputs):
    date: str
    monthlyIncomeCents: ScenarioCents


class FamilyAssistance(ModelInputs):
    limitCents: ScenarioCents
    monthlyRepaymentCents: ScenarioCents
    availableDate: str
    repaymentStartDate: str
    interestFreeConfirmed: Literal[True]


class FundingAssumptions(ModelInputs):
    months: Annotated[int, Field(strict=True, ge=1, le=60)] = 60
    payCents: ScenarioCents | None = None
    frequency: Annotated[int, Field(strict=True)] = 26
    paydayAnchor: str | None = None
    monthlySpendingCents: ScenarioCents | None = None
    reserveCents: ScenarioCents | None = None
    annualReturnPercent: Annotated[float, Field(strict=True, ge=-100, le=100)] | None = None
    seed: Seed = 42
    userInvestmentShare: Annotated[float, Field(strict=True, ge=0, le=1)] = 0.5
    shockPercent: Annotated[float, Field(strict=True, ge=-100, le=100)] = -30
    shockMonth: Annotated[int, Field(strict=True, ge=1, le=60)] = 3
    unexpectedExpenseCents: ScenarioCents | None = None
    incomeChanges: list[IncomeChange] | None = Field(default=None, max_length=60)
    familyAssistance: FamilyAssistance | None = None
    additionalIncomeObligationIds: list[str] | None = None
    purchaseFirstPaymentDates: dict[str, str] = Field(default_factory=dict)


class SpendingAssumptions(ModelInputs):
    seed: Seed = 42


class Record(BaseModel):
    model_config = ConfigDict(extra="allow", allow_inf_nan=False)
    id: str = Field(min_length=1, max_length=200)


class Entity(Record):
    name: str
    kind: Literal["personal", "business"]
    ownershipBps: Annotated[int, Field(strict=True, ge=0, le=10000)]


class Account(Record):
    entityId: str
    name: str
    type: Literal["cash", "investment", "debt", "receivable", "payable"]
    currency: Literal["CAD"]
    balanceCents: Cents


class Transaction(Record):
    accountId: str
    toAccountId: str | None = None
    date: str
    kind: Literal["income", "expense", "transfer", "debt_payment", "opening", "adjustment"]
    amountCents: Cents
    category: str

    @field_validator("date")
    @classmethod
    def valid_date(cls, value: str) -> str:
        if date.fromisoformat(value).isoformat() != value:
            raise ValueError("Use dates formatted YYYY-MM-DD.")
        return value


class FinancialSnapshot(BaseModel):
    model_config = ConfigDict(extra="allow", allow_inf_nan=False)
    workspace: Literal["demo", "live"]
    revision: Annotated[int, Field(strict=True, ge=0)]
    entities: list[Entity]
    accounts: list[Account]
    transactions: list[Transaction]
    obligations: list[dict[str, Any]]
    reserves: list[dict[str, Any]]
    positions: list[dict[str, Any]]
    assetPurchases: list[dict[str, Any]] = Field(default_factory=list)

    @model_validator(mode="after")
    def unique_records(self) -> FinancialSnapshot:
        for collection in (self.entities, self.accounts, self.transactions):
            identifiers = [record.id for record in collection]
            if len(identifiers) != len(set(identifiers)):
                raise ValueError("Snapshot record identifiers must be unique.")
        owners = {entity.id for entity in self.entities}
        accounts = {account.id: account for account in self.accounts}
        purchases = {f"asset-purchase:{row['id']}": row for row in self.assetPurchases
                     if isinstance(row.get("id"), str) and row.get("entityId") in owners}
        if len(purchases) != len(self.assetPurchases):
            raise ValueError("Purchase records need unique IDs and recorded owners.")
        if any(account.entityId not in owners for account in self.accounts):
            raise ValueError("Every account must have a recorded owner.")
        transactions = {row.id: row for row in self.transactions}
        obligations = {row["id"]: row for row in self.obligations}
        reversals: set[str] = set()
        refunds: dict[str, int] = {}
        for row in self.transactions:
            source = accounts.get(row.accountId)
            purchase = purchases.get(row.toAccountId or "")
            purchase_transfer = (purchase is not None and row.kind == "transfer" and source is not None
                                 and source.type == "cash" and source.entityId == purchase["entityId"])
            if source is None or row.toAccountId and row.toAccountId not in accounts and not purchase_transfer:
                raise ValueError("Transactions must reference recorded accounts or their owner's purchase destination.")
            reversal_id = getattr(row, "reversalOf", None)
            if reversal_id is not None:
                original = transactions.get(reversal_id)
                if (original is None or original.id == row.id or original.amountCents <= 0
                        or getattr(original, "reversalOf", None) is not None or reversal_id in reversals
                        or row.kind != original.kind or row.accountId != original.accountId
                        or row.toAccountId != original.toAccountId or row.amountCents != -original.amountCents
                        or row.date != original.date or row.category != original.category):
                    raise ValueError("A reversal must cancel one recorded original with the same kind, accounts and date.")
                reversals.add(reversal_id)
            elif row.amountCents < 0 and row.kind in ("income", "transfer", "debt_payment"):
                raise ValueError("Negative income and transfers need an explicit original reversal reference.")
            refund_id = getattr(row, "refundOf", None)
            if refund_id is not None:
                original = transactions.get(refund_id)
                if (original is None or original.kind != "expense" or original.amountCents <= 0
                        or row.kind != "expense" or row.amountCents >= 0 or reversal_id is not None
                        or accounts.get(original.accountId) is None
                        or accounts[original.accountId].entityId != source.entityId):
                    raise ValueError("A refund must reference a positive expense belonging to the same owner.")
                refunds[refund_id] = refunds.get(refund_id, 0) - row.amountCents
                if refunds[refund_id] > original.amountCents:
                    raise ValueError("Recorded refunds cannot exceed the original expense.")
            payment = getattr(row, "plannedPayment", None)
            if payment is not None:
                obligation = obligations.get(payment.get("obligationId")) if isinstance(payment, dict) else None
                expected_kind = "income" if obligation and obligation["direction"] == "in" else "expense"
                linked_purchase = obligation.get("assetPurchaseId") if obligation else None
                if (obligation is None or obligation["entityId"] != source.entityId
                        or (linked_purchase and not (purchase_transfer and row.toAccountId == f"asset-purchase:{linked_purchase}"))
                        or (not linked_purchase and row.kind != expected_kind)):
                    raise ValueError("A planned payment must reference its owner's bill and payment destination.")
            payday = getattr(row, "paydayDate", None)
            if payday is not None:
                if (row.kind != "income" or source.type != "cash" or row.amountCents <= 0
                        or next(owner.kind for owner in self.entities if owner.id == source.entityId) != "personal"
                        or not isinstance(payday, str) or date.fromisoformat(payday).isoformat() != payday):
                    raise ValueError("A payday receipt must identify recorded personal cash income and a valid payday.")
        for row in self.transactions:
            replaced = getattr(row, "replacesId", None)
            if replaced is not None and (replaced not in reversals or row.amountCents <= 0):
                raise ValueError("A replacement must reference a reversed original and have a positive amount.")
        return self


CalculationKind = Literal["planner", "daily_plan", "payoff", "spending_calendar", "comparison", "spending"]


class EngineRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    snapshot: FinancialSnapshot
    scope: str = Field(min_length=1, max_length=200)
    asOf: str
    kind: CalculationKind = "planner"
    draft: dict[str, Any] = Field(default_factory=dict)
    assumptions: dict[str, Any] = Field(default_factory=dict)

    @field_validator("asOf")
    @classmethod
    def valid_as_of(cls, value: str) -> str:
        parsed = date.fromisoformat(value)
        if parsed.isoformat() != value or not 1901 <= parsed.year <= 2199:
            raise ValueError("Choose a date between 1901 and 2199, formatted YYYY-MM-DD.")
        return value

    @model_validator(mode="after")
    def valid_scope(self) -> EngineRequest:
        if self.scope != "all" and not any(entity.id == self.scope for entity in self.snapshot.entities):
            raise ValueError("Choose a recorded owner or all accounts.")
        # Reject non-finite nested assumptions before hashing or any numerical method.
        json.dumps(self.model_dump(), allow_nan=False)
        if self.kind == "comparison":
            self.assumptions = FundingAssumptions.model_validate(self.assumptions).model_dump(exclude_unset=True)
        elif self.kind == "spending":
            self.assumptions = SpendingAssumptions.model_validate(self.assumptions).model_dump(exclude_unset=True)
        return self


@lru_cache(maxsize=1)
def dependencies() -> dict[str, str]:
    return {name: version(name) for name in ("numpy", "scipy", "statsmodels", "pymc", "cvxpy", "QuantLib")}


def envelope(request: EngineRequest, result: Any) -> dict[str, Any]:
    payload = json.dumps(request.model_dump(), sort_keys=True, separators=(",", ":"), allow_nan=False)
    return {
        "workspace": request.snapshot.workspace,
        "scope": request.scope,
        "revision": request.snapshot.revision,
        "asOf": request.asOf,
        "inputHash": hashlib.sha256(payload.encode()).hexdigest(),
        "modelVersion": MODEL_VERSION,
        "dependencies": dependencies(),
        "result": result,
    }

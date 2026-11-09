import type { DebtTerms } from '../../../shared/types';
import { validateDebtTermsModel } from '../../../shared/debt-model';
import { parseAssetMoney } from '../../../shared/asset-planning';

export interface DebtModelDraft {
  repaymentKind: string; interestStatus: string; studyEndDate: string; repaymentStartDate: string;
  split: boolean; components: { id: 'federal' | 'ontario'; balance: string; apr: string; confirmed: boolean; interestStatus: string }[];
}
export function debtModelDraft(terms?: DebtTerms): DebtModelDraft {
  return { repaymentKind: terms?.repaymentKind ?? '', interestStatus: terms?.interestStatus ?? '', studyEndDate: terms?.studyEndDate ?? '', repaymentStartDate: terms?.repaymentStartDate ?? '', split: !!terms?.components?.length,
    components: (['federal', 'ontario'] as const).map(id => { const part = terms?.components?.find(component => component.id === id); return { id, balance: part?.balanceCents == null ? '' : String(part.balanceCents / 100), apr: part?.aprPercent == null ? '' : String(part.aprPercent), confirmed: part?.rateConfirmed ?? false, interestStatus: part?.interestStatus ?? 'unknown' }; }),
  };
}
export function parseDebtModelDraft(draft: DebtModelDraft) {
  return validateDebtTermsModel({ ...(draft.repaymentKind ? { repaymentKind: draft.repaymentKind } : {}), ...(draft.interestStatus ? { interestStatus: draft.interestStatus } : {}), studyEndDate: draft.studyEndDate || null, repaymentStartDate: draft.repaymentStartDate || null,
    components: draft.split ? draft.components.map(part => ({ id: part.id, balanceCents: part.balance.trim() ? parseAssetMoney(part.balance, `${part.id} balance`) : null, aprPercent: part.apr.trim() ? Number(part.apr) : null, rateConfirmed: part.confirmed, interestStatus: part.interestStatus })) : [],
  });
}

export default function DebtModelFields({ value, onChange, supportsStudy, disabled }: { value: DebtModelDraft; onChange: (value: DebtModelDraft) => void; supportsStudy: boolean; disabled: boolean }) {
  const set = (field: 'repaymentKind' | 'interestStatus' | 'studyEndDate' | 'repaymentStartDate', input: string) => onChange({ ...value, [field]: input });
  const part = (index: number, patch: Partial<DebtModelDraft['components'][number]>) => onChange({ ...value, components: value.components.map((item, position) => position === index ? { ...item, ...patch } : item) });
  return <details className="debt-lab-assumptions"><summary>Repayment rules and loan portions</summary><div className="debt-lab-inputs">
    <label>Payment rule<select aria-label="Debt payment rule" value={value.repaymentKind} disabled={disabled} onChange={event => set('repaymentKind', event.target.value)}><option value="">Not recorded</option><option value="fixed">Fixed monthly payment</option><option value="revolving">Statement minimum changes</option><option value="interest_only">Interest only</option><option value="one_off">One payment on the due date</option></select></label>
    <label>Current interest status<select aria-label="Debt interest status" value={value.interestStatus} disabled={disabled} onChange={event => set('interestStatus', event.target.value)}><option value="">Use saved terms</option><option value="unknown">Not confirmed</option><option value="accruing">Interest accrues</option><option value="interest_free">Confirmed interest-free</option></select></label>
  </div><p>Payment deferral and interest are separate. A statement minimum is one recorded obligation. Future revolving minimums remain estimates.</p>
    {supportsStudy && <><div className="debt-lab-inputs"><label>Confirmed study end<input type="date" aria-label="Confirmed study end" value={value.studyEndDate} disabled={disabled} onChange={event => set('studyEndDate', event.target.value)}/></label><label>Confirmed repayment start<input type="date" aria-label="Confirmed repayment start" value={value.repaymentStartDate} disabled={disabled} onChange={event => set('repaymentStartDate', event.target.value)}/></label></div><p>Leave dates blank until confirmed. A return month does not establish either date. An ended study period without a repayment date needs review.</p>
      <label><input type="checkbox" aria-label="Track federal and Ontario portions" checked={value.split} disabled={disabled} onChange={event => onChange({ ...value, split: event.target.checked })}/>Track federal and Ontario portions</label>
      {value.split && value.components.map((component, index) => <fieldset key={component.id}><legend>{component.id === 'federal' ? 'Federal' : 'Ontario'} portion</legend><div className="debt-lab-inputs"><label>Balance · CAD<input aria-label={`${component.id} portion balance`} inputMode="decimal" value={component.balance} disabled={disabled} placeholder="Unknown" onChange={event => part(index, { balance: event.target.value })}/></label><label>APR · %<input aria-label={`${component.id} portion APR`} inputMode="decimal" value={component.apr} disabled={disabled} placeholder="Unknown" onChange={event => part(index, { apr: event.target.value, confirmed: false })}/></label><label>Interest status<select aria-label={`${component.id} portion interest status`} value={component.interestStatus} disabled={disabled} onChange={event => part(index, { interestStatus: event.target.value })}><option value="unknown">Not confirmed</option><option value="accruing">Interest accrues</option><option value="interest_free">Confirmed interest-free</option></select></label><label><input type="checkbox" aria-label={`${component.id} portion rate confirmed`} checked={component.confirmed} disabled={disabled || !component.apr.trim()} onChange={event => part(index, { confirmed: event.target.checked })}/>Rate matches my statement</label></div></fieldset>)}
      {value.split && <p>Both balances must add up to the saved total before projection. Unknown values remain unknown. Scenarios split payments in proportion to the component balances; confirm actual payment allocation with NSLSC.</p>}
    </>}
  </details>;
}

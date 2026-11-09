import type { Account, SourceFact } from '../../../shared/types.ts';
import type { TdMinimumEstimate as Estimate } from '../../../shared/td-minimum.ts';
import { tdAgreementUrl } from '../../../shared/td-minimum.ts';
import { money } from '../../../shared/analytics.ts';

const dateLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

export default function TdMinimumEstimate({ account, estimate, historical }: { account: Account; estimate: Estimate; historical?: SourceFact }) {
  const terms = account.debtTerms;
  return <div className="debt-study-note" aria-label="TD minimum estimate">
    <strong>Estimated regular minimum: {money(estimate.amountCents)} / month</strong>
    <p>{money(estimate.balanceCents)} × {Number(estimate.aprPercent.toFixed(2))}% ÷ 12 + $10. Capped at the balance.</p>
    {terms?.minimumPaymentCents != null && terms.statementDate ? <p>Last recorded statement: {money(terms.minimumPaymentCents)}{terms.paymentDueDate ? ` due ${dateLabel(terms.paymentDueDate)}` : ''}. Statement dated {dateLabel(terms.statementDate)}.</p> : historical && <p>Last statement reference: {historical.value}{historical.asOf ? ` · statement dated ${dateLabel(historical.asOf)}` : ''}. Current payment status is unconfirmed.</p>}
    <details><summary>How this estimate works</summary><p>Planning estimate based on the interest-plus-$10 pattern in the saved Low Rate Visa statement. Excludes fees, overdue amounts, over-limit requirements and instalments. TD uses daily balances and the actual billing period; check the current statement for the amount and date due. <a href={tdAgreementUrl} target="_blank" rel="noreferrer">TD cardholder agreement</a>.</p></details>
  </div>;
}

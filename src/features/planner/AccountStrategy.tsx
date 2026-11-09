import { useId } from 'react';
import type { AppState } from '../../../shared/types.ts';
import { money, today } from '../../../shared/analytics.ts';
import { accountStrategyData, annualInterestPerThousand } from '../../../shared/account-strategy.ts';
import { effectiveDebtApr } from '../../../shared/debt-model';
import { buildExpenseSchedule } from '../../../shared/expense-schedule.ts';
import { expensePayDates, projectedPayCents } from '../../../shared/expense-pay.ts';
import TdMinimumEstimate from '../debts/TdMinimumEstimate.tsx';
import './account-strategy.css';

interface Props { state: AppState; scope?: string; onDebts?: () => void }

const sources = {
  tdStudent: 'https://www.td.com/ca/en/personal-banking/products/bank-accounts/chequing-accounts/student-chequing-account',
  tdCard: 'https://www.td.com/ca/en/personal-banking/products/credit-cards/low-rate',
  cibcLimit: 'https://www.cibc.com/content/dam/personal_banking/bank_accounts/pdfs/12418-education-line-of-credit-terms-and-conditions-en.pdf',
  debt: 'https://www.canada.ca/en/financial-consumer-agency/services/debt/paying-debt.html',
  credit: 'https://www.canada.ca/en/financial-consumer-agency/services/credit-reports-score/improve-credit-score.html',
};
const dateLabel = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const rateLabel = (value: number) => `${new Intl.NumberFormat('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}%`;

export default function AccountStrategy({ state, scope = 'all', onDebts }: Props) {
  const id = useId();
  const data = accountStrategyData(state, scope);
  const owner = state.entities.find(entity => entity.id === data.ownerId);
  if (!owner || owner.kind !== 'personal') return null;
  const facts = state.sourceFacts ?? [];
  const asOf = today();
  const schedule = buildExpenseSchedule(state, owner.id, asOf, 90);
  const nextPayment = [...schedule.past, ...schedule.upcoming].find(event => event.direction === 'out' && event.amountCents !== 0);
  const payday = expensePayDates(state.roadmap, asOf, 2).find(date => date > asOf);
  const payAmount = payday ? projectedPayCents(state.roadmap, payday) : null;
  const historicalTd = facts.find(fact => fact.id === 'td-august-terms');
  const missing = [!data.livingCostsKnown ? 'Monthly living costs' : '', data.tdCard && !data.tdMinimumKnown && !data.tdMinimumEstimate ? 'Current TD minimum and due date' : ''].filter(Boolean);
  const first = data.rankedDebts[0];
  const second = data.rankedDebts[1];

  return <section className="account-strategy" aria-labelledby={`${id}-heading`}>
    <header><div><h2 id={`${id}-heading`}>Account strategy</h2><p>Use the recorded balances and terms to decide what needs attention next.</p></div>{onDebts && <button type="button" className="account-strategy-link" onClick={onDebts}>Review debt terms</button>}</header>
    <div className="account-strategy-first"><h3>{missing.length ? 'Confirm missing inputs before choosing contributions' : 'Cover bills and debt minimums before investing'}</h3><p>{missing.length ? 'Saved records still need the inputs listed below. Enter explicit assumptions in the allocation comparison to test a funding plan.' : 'Use the cash plan to check payment dates and living costs before assigning money elsewhere.'}</p>
      <dl><div><dt>Recorded personal cash</dt><dd>{data.cashCents === null ? 'Unknown' : money(data.cashCents)}</dd></div>{nextPayment && <div><dt>{nextPayment.date < asOf ? 'Past-due payment to review' : 'Next scheduled payment'}</dt><dd>{nextPayment.amountCents === null ? 'Amount unknown' : money(nextPayment.amountCents)} · {dateLabel(nextPayment.date)}</dd></div>}{payday && <div><dt>Next scheduled payday</dt><dd>{dateLabel(payday)} · {payAmount == null ? 'Amount unknown' : `${money(payAmount)} estimated`}</dd></div>}</dl>
      {nextPayment && <p>{nextPayment.name}{nextPayment.date < asOf ? '. Confirm whether this payment has been made.' : '.'}</p>}{payday && <p>The saved pay schedule is an estimate. Scheduled income is not recorded cash.</p>}
      {missing.length > 0 && <p className="account-strategy-missing">Still needed: {missing.join('; ')}.</p>}
      {data.tdCard && data.tdMinimumEstimate && <TdMinimumEstimate account={data.tdCard} estimate={data.tdMinimumEstimate} historical={historicalTd}/>}
    </div>

    <div className="account-strategy-rates"><h3>Active debt rates</h3><p>Simple annual interest on an unchanged $1,000 balance. Deferred loans are left out.</p>
      {data.rankedDebts.length ? <div className="account-strategy-rate-list">{data.rankedDebts.map(account => <article key={account.id}><div><strong>{account.name}</strong><small>{account.debtTerms!.statementDate ? `Rate recorded ${dateLabel(account.debtTerms!.statementDate!)}` : 'Confirmed rate in saved terms'}</small></div><div><strong>{rateLabel(effectiveDebtApr(account,true)!)}</strong><small>Recorded APR</small></div><div><strong>{money(annualInterestPerThousand(effectiveDebtApr(account,true)!))}</strong><small>Per $1,000 over one year</small></div></article>)}</div> : <p>No interest-bearing debt has a confirmed rate yet.</p>}
      {first && second && <p>{first.name} costs {money(annualInterestPerThousand(effectiveDebtApr(first,true)!) - annualInterestPerThousand(effectiveDebtApr(second,true)!))} more per $1,000 over one year than {second.name} at these rates.</p>}
      <p className="account-strategy-method">This comparison holds the principal and rate constant. It excludes fees, payments and compounding; actual lender interest will differ.</p>
      <p>After essential expenses, any past-due amounts and all minimums are covered, putting extra debt payments toward the highest interest rate reduces interest costs. <a href={sources.debt} target="_blank" rel="noreferrer">FCAC debt repayment guidance</a>.</p>
      {data.debtsMissingRates.length > 0 && <p>Rates still need confirmation for {data.debtsMissingRates.map(account => account.name).join(', ')}. Those debts are excluded from the ranking above.</p>}
    </div>

    <div className="account-strategy-checks">
      {data.tdChequing && <details><summary><span>TD Student Chequing</span><strong>Confirm student eligibility</strong></summary><p>TD lists a $0 monthly fee and unlimited transactions. At age 23 or older, keeping the student account requires proof of full-time post-secondary enrolment. Confirm your eligibility and the proof TD needs before relying on that fee treatment. <a href={sources.tdStudent} target="_blank" rel="noreferrer">TD Student Chequing terms</a>.</p></details>}
      {data.tdCard && <details><summary><span>TD Low Rate Visa</span><strong>{data.tdMinimumEstimate ? `${money(data.tdMinimumEstimate.amountCents)} estimated regular minimum` : 'Confirm the next minimum, due date and fee'}</strong></summary><p>{data.tdMinimumKnown ? `The saved minimum is ${money(data.tdCard.debtTerms!.minimumPaymentCents!)} due ${dateLabel(data.tdCard.debtTerms!.paymentDueDate!)}.` : 'The planner can use the regular-minimum estimate. Confirm the actual amount and due date from the current statement before paying.'} TD publicly lists a $25 annual fee for this card. Check your own statement for the fee or any waiver; a new-account promotion does not establish your existing account's terms. <a href={sources.tdCard} target="_blank" rel="noreferrer">TD Low Rate Visa terms</a>.</p>
        {historicalTd && <div className="account-strategy-historical"><strong>Historical statement reference{historicalTd.asOf ? ` · ${dateLabel(historicalTd.asOf)}` : ''}</strong><p>{historicalTd.note}</p><small>{historicalTd.sourceFile}</small></div>}
        <p>Confirm the current credit limit before treating a balance-to-limit percentage as current utilization. FCAC advises keeping credit use low and paying on time. These steps do not promise a particular score increase. <a href={sources.credit} target="_blank" rel="noreferrer">FCAC credit guidance</a>.</p>
      </details>}
      {data.cibcLine && <details><summary><span>CIBC student line of credit</span><strong>Confirm any increase before budgeting with it</strong></summary><p>{data.cibcLine.evidence?.creditLimitCents !== undefined ? `The saved bank source shows a ${money(data.cibcLine.evidence.creditLimitCents)} limit${data.cibcLine.evidence.asOf ? ` as of ${dateLabel(data.cibcLine.evidence.asOf)}` : ''}. ` : ''}A possible additional limit is not recorded cash. CIBC's terms say a limit increase may require a credit bureau check and a cash-flow review. Get the approved limit and repayment terms from CIBC before using an increase in a plan. <a href={sources.cibcLimit} target="_blank" rel="noreferrer">CIBC education line of credit terms</a>.</p></details>}
    </div>
    <footer>Public product terms checked September 24, 2026. Your saved account terms and source dates appear above.</footer>
  </section>;
}

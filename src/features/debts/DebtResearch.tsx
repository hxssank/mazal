import type { Account } from '../../../shared/types.ts';
import { money } from '../../../shared/analytics.ts';
import { annualInterestSavedCents, interestPriority, loanGuideFor, loanResearchDate } from '../../../shared/loan-guidance.ts';
import { effectiveDebtApr } from '../../../shared/debt-model.ts';
import './debt-research.css';

export function DebtPriority({ accounts, onSelect }: { accounts: Account[]; onSelect: (id: string) => void }) {
  const ranked = interestPriority(accounts);
  if (!ranked.length) return null;
  return <section className="night-glass debt-priority" aria-label="Extra payment priority">
    <h2>Where extra payments go</h2>
    <p>Cover essentials, required minimums and agreed payment dates first. Then put extra money toward the highest confirmed rate.</p>
    <ol>{ranked.map(account => <li key={account.id}><button className="text-button" onClick={() => onSelect(account.id)}>{account.name}</button><span>{Number(effectiveDebtApr(account,true)!.toFixed(2))}% APR</span><small>{money(annualInterestSavedCents(account)!)} per year on {money(Math.min(100000, account.balanceCents))} repaid</small></li>)}</ol>
    <p className="debt-research-note">Simple annual interest comparison at saved rates, with no new borrowing. Unknown interest status and unconfirmed rates are excluded. Payment deferral alone does not mean interest-free. Component rates use their share of the balance. Zero-interest debts still follow their agreed dates.</p>
  </section>;
}

export default function DebtResearch({ account }: { account: Account }) {
  const guide = loanGuideFor(account);
  if (!guide) return null;
  return <section className="night-glass debt-research" aria-label={`Fees and rules for ${account.name}`}>
    <div className="debt-research-heading"><h2>Fees and repayment rules</h2><span>Checked {loanResearchDate}</span></div>
    <p className="debt-research-note">{guide.product}. Public product rules; your signed agreement and latest statement control your account.</p>
    <div className="debt-research-findings">{guide.findings.map(finding => <article key={finding.title}><h3>{finding.title}</h3><p>{finding.detail}</p><div className="debt-research-sources">{finding.sources.map(source => <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.title}</a>)}</div></article>)}</div>
    <details><summary>Still to confirm for this account</summary><ul>{guide.confirm.map(item => <li key={item}>{item}</li>)}</ul></details>
  </section>;
}

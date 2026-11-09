import type { Account } from './types.ts';
import { effectiveDebtApr, rankedInterestDebts } from './debt-model.ts';

export const loanResearchDate = '2026-09-24';
export interface LoanSource { title: string; url: string }
export interface LoanFinding { title: string; detail: string; sources: LoanSource[] }
export interface LoanGuide { product: string; findings: LoanFinding[]; confirm: string[] }

const tdProduct: LoanSource = { title: 'TD Low Rate Visa terms', url: 'https://www.td.com/ca/en/personal-banking/products/credit-cards/low-rate/low-rate-visa-card' };
const tdAgreement: LoanSource = { title: 'TD cardholder agreement', url: 'https://www.td.com/content/dam/tdct/document/pdf/personal-banking/12128-599186-cha-25-a1-en.pdf' };
const cibcProduct: LoanSource = { title: 'CIBC Professional Edge terms', url: 'https://www.cibc.com/en/student/student-lines-of-credit/professional-students.html' };
const cibcPrepay: LoanSource = { title: 'CIBC student LOC repayment', url: 'https://www.cibc.com/en/personal-banking/loans-and-lines-of-credit/articles-resources/student-line-of-credit-overview.html' };
const cibcContract: LoanSource = { title: 'CIBC published contract, April 2018', url: 'https://www.cibc.com/content/dam/personal_banking/bank_accounts/pdfs/12418-education-line-of-credit-terms-and-conditions-en.pdf' };
const osapRepay: LoanSource = { title: 'Ontario OSAP repayment rules', url: 'https://www.ontario.ca/page/pay-back-osap' };
const osapEnrolment: LoanSource = { title: 'NSLSC enrolment confirmation', url: 'https://www.csnpe-nslsc.canada.ca/en/confirmation-of-enrolment' };
const osapContract: LoanSource = { title: 'Canada-Ontario loan agreement', url: 'https://www.csnpe-nslsc.canada.ca/en/additional-resources/on-terms-and-conditions' };
const studentCredit: LoanSource = { title: 'CRA student-loan interest credit', url: 'https://www.canada.ca/en/revenue-agency/services/tax/individuals/topics/about-your-tax-return/tax-return/completing-a-tax-return/deductions-credits-expenses/line-31900-interest-paid-on-your-student-loans.html' };

const tdGuide: LoanGuide = {
  product: 'TD Low Rate Visa',
  findings: [
    { title: 'Two missed minimums can nearly double the purchase rate', detail: 'Two missed minimum payments within 12 statement periods can raise purchases to 24.99% and cash advances to 27.99%. Returning to the normal rate requires 12 consecutive on-time minimum payments.', sources: [tdProduct, tdAgreement] },
    { title: 'The minimum does not preserve the purchase grace period', detail: 'Pay the full statement balance by its due date for the purchase grace period. Cash advances have no grace period. While carrying a balance, new purchases can also accrue interest.', sources: [tdAgreement] },
    { title: 'Unpaid interest now earns interest', detail: 'Since July 2, 2026, TD adds unpaid interest to the balance at statement end and charges interest on it. Payments reduce daily balances, so paying available surplus earlier reduces interest.', sources: [tdAgreement] },
    { title: '$25 advertised annual fee; check your other charges', detail: 'The current product lists a $25 annual fee before any account-specific rebate. Overlimit amounts also enter the required minimum. Returned-payment, cash-advance and foreign-currency fee amounts depend on your disclosure.', sources: [{ title: 'TD annual fee', url: 'https://www.td.com/ca/en/personal-banking/products/credit-cards/low-rate' }, tdAgreement] },
  ],
  confirm: ['Get the current statement minimum, due date, credit limit and any past-due or overlimit amount. The August statement is historical.', 'Check your own disclosure for annual, cash-advance, returned-payment, overlimit and foreign-currency fees.'],
};
const cibcGuide: LoanGuide = {
  product: 'CIBC Professional Student line of credit',
  findings: [
    { title: 'School defers principal, not monthly interest', detail: 'CIBC requires interest payments during school. Paying only interest keeps the principal outstanding. Extra principal payments reduce the balance that accrues interest.', sources: [cibcProduct] },
    { title: 'The principal grace period depends on your program', detail: 'CIBC advertises up to 12 months after graduation for most eligible programs and up to 24 months for medical, dental and optometry students. Leaving the program can trigger conversion to a loan with principal and interest payments.', sources: [cibcProduct] },
    { title: 'Extra payments have no prepayment penalty', detail: 'CIBC allows student LOC payments as often as desired without a prepayment penalty. Its rate varies with prime, so refresh the saved APR when the bank changes it.', sources: [cibcPrepay, cibcProduct] },
    { title: 'Missed payments can change the loan', detail: 'The published April 2018 contract allows conversion to an instalment loan after a missed minimum. It also lists overlimit, dishonoured-payment and optional insurance charges. Check these older published clauses and fee amounts against your signed agreement and amendments.', sources: [cibcContract] },
  ],
  confirm: ['Confirm the program, prime-rate spread and principal repayment start date in your agreement.', 'Ask for the fee schedule and a dated payoff quote before clearing the account. A payoff quote can differ from the displayed balance.'],
};
const osapGuide: LoanGuide = {
  product: 'OSAP government student loan',
  findings: [
    { title: 'Confirmed study status controls when payments start', detail: 'Eligible confirmed full-time studies can keep payments deferred. Repayment can start six months after a study period ends, even before graduation. A January return alone does not establish the status of the current gap.', sources: [osapRepay, osapEnrolment] },
    { title: 'Federal and Ontario interest work differently', detail: 'The federal portion has no new interest. Ontario normally charges prime plus 1% outside qualifying interest-free status, including the six-month non-repayment period. Keep the split unknown until NSLSC confirms it.', sources: [osapRepay, osapContract] },
    { title: 'Keep enrolment confirmed when returning', detail: 'If you are not taking new funding, confirm enrolment to retain the applicable deferral. A full-time return can defer full-time and part-time loans; a part-time return only defers part-time loans.', sources: [osapEnrolment] },
    { title: 'Avoid moving interest-free OSAP into a bank loan', detail: 'Early government-loan repayment has no penalty. Refinancing the federal portion into an interest-bearing LOC creates interest, and refinanced government debt loses eligibility for the student-loan interest tax credit.', sources: [osapContract, studentCredit] },
  ],
  confirm: ['NSLSC current balance, federal/Ontario split, current study status and last confirmed study end date.', 'January course load and enrolment confirmation. Graduation remains unknown; do not use the return month as a payment start date.', 'If Ontario interest later applies, confirm how a targeted Ontario payment would be allocated before paying it.'],
};

export function loanGuideFor(account: Account): LoanGuide | null {
  if (!['debt', 'payable'].includes(account.type)) return null;
  if (/\bTD\b.*\bLow Rate\b.*\bVisa\b/i.test(account.name)) return tdGuide;
  if (/\bCIBC\b.*\bProfessional\b.*\b(?:LOC|line of credit)\b/i.test(account.name)) return cibcGuide;
  if (/\bOSAP\b/i.test(account.name)) return osapGuide;
  return null;
}

export function interestPriority(accounts: Account[]): Account[] {
  return rankedInterestDebts(accounts);
}

export function annualInterestSavedCents(account: Account, principalCents = 100000): number | null {
  const rate = effectiveDebtApr(account, true);
  if (rate == null) return null;
  return Math.round(Math.min(Math.max(0, principalCents), Math.max(0, account.balanceCents)) * rate / 100);
}

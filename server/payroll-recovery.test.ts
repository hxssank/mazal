import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { gzipSync } from 'node:zlib';
import type { PayrollImport } from '../shared/payroll.ts';
import { createDocumentRecovery } from './document-recovery.ts';
import { createDocumentStore } from './documents.ts';
import { createStore } from './store.ts';

const pdf = Buffer.from('%PDF-1.7\nSynthetic payroll record.\n%%EOF\n');
const sha256 = createHash('sha256').update(pdf).digest('hex');

function setup(t: TestContext) {
  const base = mkdtempSync(join(tmpdir(), 'mazal-payroll-recovery-'));
  const financePath = join(base, 'finance.sqlite');
  const finance = createStore(financePath, 'live');
  const directory = join(base, 'documents');
  const documents = createDocumentStore(directory, id => finance.state().accounts.some(account => account.id === id));
  const recovery = createDocumentRecovery({ directory, sourceDirectory: join(base, 'sources'), financePath, documents });
  t.after(() => { documents.close(); finance.close(); rmSync(base, { recursive: true, force: true }); });
  return { finance, documents, directory, recovery };
}

function payroll(): PayrollImport {
  return {
    id: 'payroll-recovery', importedAt: '2026-01-30T12:00:00.000Z', schemaVersion: 1, currency: 'CAD', archive: { filename: 'Payroll.zip', sha256: 'a'.repeat(64) },
    sources: [{ id: 'pay-source', filename: 'Pay.pdf', sha256, mimeType: 'application/pdf', kind: 'paystub', pageCount: 1 }],
    paystubs: [{ id: 'pay-1', sourceId: 'pay-source', sourcePage: 1, payDate: '2026-01-30', periodStart: '2026-01-01', periodEnd: '2026-01-14', sequence: 'ONE', employer: 'Example employer', payFrequency: 'Biweekly', payRate: '25.0000', grossCents: 200000, netCents: 150000, taxCents: 45000, deductionCents: 5000, hours: 80,
      earnings: [{ label: 'Regular', hours: 80, rate: '25.0000', amountCents: 200000, ytdHours: 80, ytdAmountCents: 200000 }],
      taxes: [{ label: 'Tax', amountCents: 45000, ytdAmountCents: 45000 }], deductions: [{ label: 'Union', amountCents: 5000, ytdAmountCents: 5000 }],
      ytd: { grossCents: 200000, netCents: 150000, taxCents: 45000, deductionCents: 5000, hours: 80 }, paymentMethod: 'Direct deposit', vacationBalanceCents: null, vacationAccruedCents: null }],
    timecards: [], issues: [],
  };
}

test('payroll originals are required by hash without an account link, and repeated references count once', t => {
  const target = setup(t);
  target.documents.upload(pdf, { originalName: 'Renamed payroll.pdf', kind: 'other' });
  const statement = target.documents.upload(Buffer.from('%PDF-1.7\nSynthetic bank statement.'), { originalName: 'Statement.pdf', kind: 'statement' }).document;
  const other = target.documents.upload(Buffer.from('%PDF-1.7\nUnidentified record.'), { originalName: 'Other.pdf', kind: 'other' }).document;
  const state = target.finance.state();
  state.payrollImports = [payroll(), { ...payroll(), id: 'repeated-source' }];
  const health = target.recovery.health(state);
  assert.equal(health.sourceReferences, 1);
  assert.equal(health.missingSourceReferences, 0);
  assert.equal(health.unlinkedDocuments, 2);
  assert.deepEqual(new Set(health.issues.filter(issue => issue.kind === 'unlinked_document').map(issue => issue.documentId)), new Set([statement.id, other.id]));
  assert.equal(health.missingAccountLinks, 0);
});

test('payroll health rejects same-name replacements and reports missing or damaged originals', t => {
  const target = setup(t);
  const state = target.finance.state();
  state.payrollImports = [payroll()];
  let health = target.recovery.health(state);
  assert.equal(health.documents, 0);
  assert.equal(health.missingSourceReferences, 1);
  assert.match(health.issues[0].message, /Pay\.pdf: payroll original is missing or does not match its SHA-256/);
  target.documents.upload(Buffer.from('%PDF-1.7\nDifferent payroll record.'), { originalName: 'Pay.pdf', kind: 'other' });
  assert.equal(target.recovery.health(state).missingSourceReferences, 1);
  const document = target.documents.upload(pdf, { originalName: 'Pay.pdf', kind: 'other' }).document;
  const path = join(target.directory, `${document.id}.original`);
  assert.equal(target.recovery.health(state).missingSourceReferences, 0);
  rmSync(path);
  health = target.recovery.health(state);
  assert.equal(health.missingOriginals, 1);
  assert.equal(health.missingSourceReferences, 1);
  writeFileSync(path, Buffer.from('%PDF-1.7\nTampered payroll record.'));
  health = target.recovery.health(state);
  assert.equal(health.damagedOriginals, 1);
  assert.equal(health.missingSourceReferences, 1);
  assert.equal(health.issues.find(issue => issue.kind === 'missing_source_reference')?.documentId, sha256);
});

test('financial and original-file recovery restores payroll evidence without creating account links', async t => {
  const source = setup(t);
  source.documents.upload(pdf, { originalName: 'Pay.pdf', kind: 'other', accountId: null });
  source.finance.command({ type: 'import_payroll', import: payroll(), expectedRevision: 0, requestId: 'payroll-recovery-import' });
  const archive = gzipSync(Buffer.concat([...source.documents.export()]));
  const target = setup(t);
  const restored = target.finance.restore(source.finance.export(), 0);
  assert.equal(target.recovery.health(restored).missingSourceReferences, 1);
  const preview = await target.recovery.preview(archive, async () => target.finance.state());
  assert.equal(preview.counts.unresolvedLinks, 0);
  assert.equal(preview.documents[0].suggestedAccountId, null);
  assert.equal(preview.documents[0].linkReason, 'unlinked');
  const command = { token: preview.token, expectedRevision: preview.expectedRevision };
  const result = target.recovery.commit(command, target.finance.state());
  assert.equal(result.documentsAdded, 1);
  assert.equal(result.unlinkedDocuments, 0);
  assert.equal(result.recovery.unlinkedDocuments, 0);
  assert.equal(result.recovery.missingSourceReferences, 0);
  assert.equal(target.documents.list().documents[0].accountId, null);
  assert.deepEqual(target.documents.content(sha256).bytes, pdf);
  assert.deepEqual(target.finance.state(), restored);
  assert.deepEqual(target.recovery.commit(command, target.finance.state()), result);
});

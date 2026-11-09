import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { PayrollImport } from '../shared/payroll.ts';

test('payroll HTTP import requires preserved matching originals and does not create cash', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-payroll-http-'));
  const port = 30000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['server/index.ts'], { env: { ...process.env, PORT: String(port), MAZAL_DATA_DIR: directory, MAZAL_MASTER_WORKBOOK: join(directory, 'export.xlsx') }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null) { const exit = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGTERM'); await exit; }
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Payroll test server did not start.')), 8000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Payroll test server exited with ${code}.`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const bytes = '%PDF-1.4\nSynthetic payroll source';
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const payroll: PayrollImport = {
    id: 'payroll-test', importedAt: '2026-01-30T12:00:00.000Z', schemaVersion: 1, currency: 'CAD', archive: { filename: 'Payroll.zip', sha256: 'b'.repeat(64) },
    sources: [{ id: 'pay-source', filename: 'Pay.pdf', sha256, mimeType: 'application/pdf', kind: 'paystub', pageCount: 1 }],
    paystubs: [{ id: 'pay-1', sourceId: 'pay-source', sourcePage: 1, payDate: '2026-01-30', periodStart: '2026-01-01', periodEnd: '2026-01-14', sequence: 'ONE', employer: 'Example employer', payFrequency: 'Biweekly', payRate: '25.0000', grossCents: 200000, netCents: 150000, taxCents: 45000, deductionCents: 5000, hours: 80,
      earnings: [{ label: 'Regular', hours: 80, rate: '25.0000', amountCents: 200000, ytdHours: 80, ytdAmountCents: 200000 }],
      taxes: [{ label: 'Tax', amountCents: 45000, ytdAmountCents: 45000 }], deductions: [{ label: 'Union', amountCents: 5000, ytdAmountCents: 5000 }],
      ytd: { grossCents: 200000, netCents: 150000, taxCents: 45000, deductionCents: 5000, hours: 80 }, paymentMethod: 'Direct deposit', vacationBalanceCents: null, vacationAccruedCents: null }],
    timecards: [], issues: [],
  };
  const state = () => fetch(`${base}/api/state`).then(response => response.json());
  const before = await state();
  const command = (payload: PayrollImport, revision = before.revision) => fetch(`${base}/api/command`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'import_payroll', import: payload, expectedRevision: revision, requestId: 'import-payroll-test' }) });
  assert.equal((await command(payroll)).status, 404);
  assert.deepEqual(await state(), before);
  const upload = await fetch(`${base}/api/documents`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Mazal-Document': encodeURIComponent(JSON.stringify({ originalName: 'Pay.pdf', kind: 'other' })) }, body: bytes });
  assert.equal(upload.status, 201);
  const mismatch = structuredClone(payroll);
  mismatch.sources[0].filename = 'Different.pdf';
  assert.equal((await command(mismatch)).status, 400);
  assert.deepEqual(await state(), before);
  const imported = await command(payroll);
  assert.equal(imported.status, 200);
  const saved = await imported.json();
  assert.deepEqual(saved.payrollImports, [payroll]);
  assert.deepEqual(saved.accounts, before.accounts);
  assert.deepEqual(saved.transactions, before.transactions);
  assert.deepEqual(await (await command(payroll)).json(), saved);
  const original = await fetch(`${base}/api/documents/${sha256}/content`);
  assert.equal(await original.text(), bytes);
  writeFileSync(join(directory, 'documents', 'live', `${sha256}.original`), '%PDF-1.4\nChanged payroll contents');
  assert.equal((await command(payroll, saved.revision)).status, 500);
  assert.deepEqual(await state(), saved);
});

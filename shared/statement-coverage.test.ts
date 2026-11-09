import assert from 'node:assert/strict';
import { test } from 'node:test';
import { statementCoverage } from './statement-imports.ts';
import type { Account, AppState, StatementBatch, StatementImport, StatementSource } from './types.ts';
import { engineFixtureResult } from '../src/engine-test-fixture.ts';

function state(): Pick<AppState, 'accounts' | 'statements' | 'importBatches'> {
  const account = (id: string, entityId: string, type: Account['type']): Account => ({ id, entityId, type, name: id, currency: 'CAD', balanceCents: 0, reconciledAt: null });
  return { accounts: [account('bank', 'me', 'cash'), account('card', 'me', 'debt'), account('shop-bank', 'shop', 'cash'), account('investments', 'me', 'investment')], statements: [], importBatches: [] };
}

function source(id: string, accountId = 'bank', periodStart = '2026-09-01', periodEnd = '2026-09-30'): StatementSource {
  return { id, accountId, sourceFile: `${id}.pdf`, sha256: 'a'.repeat(64), periodStart, periodEnd, openingBalanceCents: 0, closingBalanceCents: 0, rows: [] };
}

function batch(statement: StatementSource, status: StatementBatch['status'] = 'committed'): StatementBatch {
  return { id: statement.id, source: statement, decisions: [], status, createdAt: '2026-09-24T12:00:00.000Z', committedAt: status === 'committed' ? '2026-09-24T12:00:00.000Z' : null };
}

test('coverage includes committed batches and legacy statements, scoped to the owner and selected account', () => {
  const data = state();
  data.statements = [source('card', 'card') as StatementImport, source('shop', 'shop-bank') as StatementImport];
  data.importBatches = [batch(source('bank'))];
  const personal = statementCoverage(data, 'me', '2026-09');
  assert.equal(personal.status, 'complete');
  assert.equal(personal.accountCount, 2);
  assert.equal(personal.completeAccountCount, 2);
  assert.equal(personal.coveredAccountDays, 60);
  assert.equal(personal.totalAccountDays, 60);
  assert.deepEqual(personal.accounts.map(account => account.accountId), ['bank', 'card']);
  assert.equal(statementCoverage(data, 'me', '2026-09', 'bank').accountCount, 1);
  assert.equal(statementCoverage(data, 'me', '2026-09', 'shop-bank').status, 'none');
  assert.equal(statementCoverage(data, 'all', '2026-09').accountCount, 3);
});

test('a staged statement and another owner cannot claim coverage', () => {
  const data = state();
  data.statements = [source('shop', 'shop-bank') as StatementImport];
  data.importBatches = [batch(source('staged-bank'), 'staged')];
  const personal = statementCoverage(data, 'me', '2026-09');
  assert.equal(personal.status, 'none');
  assert.equal(personal.coveredAccountCount, 0);
  assert.equal(personal.coveredAccountDays, 0);
  assert.equal(statementCoverage(data, 'shop', '2026-09').status, 'complete');
});

test('overlapping and duplicate periods form a union while one missing day remains partial', () => {
  const data = state();
  data.statements = [source('first', 'bank', '2026-08-20', '2026-09-10') as StatementImport];
  data.importBatches = [batch(source('duplicate-first', 'bank', '2026-08-20', '2026-09-10')), batch(source('middle', 'bank', '2026-09-08', '2026-09-19')), batch(source('last', 'bank', '2026-09-21', '2026-10-10'))];
  const partial = statementCoverage(data, 'me', '2026-09', 'bank');
  assert.equal(partial.status, 'partial');
  assert.equal(partial.coveredAccountDays, 29);
  data.importBatches.push(batch(source('missing-day', 'bank', '2026-09-20', '2026-09-20')));
  assert.equal(statementCoverage(data, 'me', '2026-09', 'bank').status, 'complete');
  assert.equal(statementCoverage(data, 'me', '2026-09').status, 'partial');
  assert.equal(statementCoverage(data, 'me', '2026-09').completeAccountCount, 1);
});

test('coverage measures leap months and excludes periods outside the requested month', () => {
  const data = state();
  data.statements = [source('february', 'bank', '2028-02-01', '2028-02-28') as StatementImport, source('march', 'bank', '2028-03-01', '2028-03-31') as StatementImport];
  const partial = statementCoverage(data, 'me', '2028-02', 'bank');
  assert.equal(partial.status, 'partial');
  assert.equal(partial.coveredAccountDays, 28);
  assert.equal(partial.totalAccountDays, 29);
  assert.equal(statementCoverage(data, 'me', '2028-01', 'bank').status, 'none');
  data.accounts = [];
  assert.equal(statementCoverage(data, 'all', '2028-02').status, 'none');
  assert.throws(() => statementCoverage(data, 'all', '2028-13'), /calendar month/);
});

test('closed accounts require only their active days and match the production calendar', () => {
  const data = state();
  data.accounts.find(account => account.id === 'bank')!.closedAt = '2026-08-31';
  data.accounts.find(account => account.id === 'card')!.closedAt = '2026-09-15';
  data.statements = [source('final-card', 'card', '2026-09-01', '2026-09-15') as StatementImport];
  const result = statementCoverage(data, 'me', '2026-09');
  assert.equal(result.status, 'complete');
  assert.equal(result.accountCount, 1);
  assert.equal(result.totalAccountDays, 15);
  const snapshot: AppState = { ...data, workspace: 'live', revision: 0, entities: [{ id: 'me', name: 'Personal', kind: 'personal', ownershipBps: 10000 }], transactions: [], positions: [], obligations: [], reserves: [], audit: [], lastBackupAt: null };
  const actual = engineFixtureResult(snapshot, 'me', '2026-09-30', 'spending_calendar', { month: '2026-09' }) as { coverage: unknown };
  assert.deepEqual(result, actual.coverage);
  data.statements[0].periodEnd = '2026-09-14';
  assert.equal(statementCoverage(data, 'me', '2026-09').status, 'partial');
  assert.equal(statementCoverage(data, 'me', '2026-10').accountCount, 0);
});

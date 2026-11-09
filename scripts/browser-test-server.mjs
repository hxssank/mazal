import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../server/store.ts';
import { today } from '../shared/analytics.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const directory = mkdtempSync(join(tmpdir(), 'mazal-desktop-browser-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MAZAL_')));
const date = today();
try {
  const store = createStore(join(directory, 'live.sqlite'), 'live');
  try {
    const account = store.command({ type: 'add_account', entityId: 'personal', name: 'Browser test cash', accountType: 'cash', openingBalanceCents: 500000, openingDate: date }).accounts[0];
    store.command({ type: 'add_obligation', entityId: 'personal', accountId: account.id, name: 'Browser test rent', amountCents: 100000, dueDate: date, direction: 'out', recurrence: 'monthly', category: 'Housing' });
    for (const [name, aprPercent] of [['Browser test high-rate card', 20], ['Browser test lower-rate loan', 5]]) {
      const state = store.command({ type: 'add_account', entityId: 'personal', name, accountType: 'debt', openingBalanceCents: 100000, openingDate: date });
      const loan = state.accounts.find(item => item.name === name);
      store.command({ type: 'set_debt_terms', accountId: loan.id, terms: { aprPercent, rateConfirmed: true, minimumPaymentCents: 5000, paymentDueDate: date, statementDate: date, notes: '' } });
    }
  } finally { store.close(); }
  const child = spawn(process.execPath, ['server/index.ts'], {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...env,
      NODE_ENV: 'production',
      PORT: process.env.MAZAL_BROWSER_PORT ?? '5497',
      MAZAL_DATA_DIR: directory,
      MAZAL_MASTER_WORKBOOK: join(directory, 'test-workbook.xlsx'),
      MAZAL_SAMPLE_PREVIEW: '1',
      MAZAL_ENGINE_AUTOSTART: '1',
    },
  });
  let stopping = false;
  const stop = () => { stopping = true; child.kill('SIGTERM'); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(stopping ? 0 : code ?? 1));
  });
} finally { rmSync(directory, { recursive: true, force: true }); }

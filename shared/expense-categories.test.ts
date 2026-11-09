import assert from 'node:assert/strict';
import { test } from 'node:test';
import { categoryLimits, isUncategorized, plannedExpenseCategory, suggestExpenseCategory } from './expense-categories.ts';
import { buildExpensePlan, expensePlanTransactionCategory } from './expense-plan.ts';
import { spendingOverview } from './spending.ts';
import type { AppState, Obligation, Transaction } from './types.ts';

function state(): AppState {
  return { workspace: 'live', revision: 0, entities: [{ id: 'me', name: 'Personal', kind: 'personal', ownershipBps: 10000 }], accounts: [{ id: 'bank', entityId: 'me', name: 'Bank', type: 'cash', currency: 'CAD', balanceCents: 0, reconciledAt: null }], transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null };
}

function expense(id: string, category: string, amountCents = 1000, source = 'Manual entry'): Transaction {
  return { id, category, amountCents, source, date: '2026-09-22', kind: 'expense', accountId: 'bank', toAccountId: null, description: id, createdAt: '2026-09-22T12:00:00Z' };
}

test('merchant suggestions distinguish memberships, supplements, food and mixed gas purchases', () => {
  const examples: [string, string][] = [
    ['RETAIL INTEREST', 'Fees & interest'], ['CASH INTEREST', 'Fees & interest'],
    ['CINEPLEX CINECLUB 416-555-0100', 'Subscriptions'], ['CINEPLEX 8030 WEB QPS', 'Social'],
    ['CINEPLEX 7122', 'Social'], ['ANTHROPIC* CLAUDE SUB ANTHROPIC.CO', 'Subscriptions'],
    ['NEIGHBOURHOOD CAFE', 'Food'], ['UBER CANADA/UBEREATS', 'Food'], ['CHICK-FIL-A 30011', 'Food'],
    ['KUNG FU TEA', 'Food'], ['RABBA FINE FOODS # 115', 'Food'], ['PAK FOODS', 'Food'],
    ["MCDONALD'S #8898 Q04", 'Food'], ['FIREFLY BURGER', 'Food'], ['TAZA XPRESS FOWLER', 'Food'],
    ['TIM HORTONS #2079', 'Food'], ['NABLUS CREAMERY', 'Food'], ['TST-Laymoon Restaurant', 'Food'],
    ['TST-Namkeen - Downtown', 'Food'], ['TST-Mieluna Cafe', 'Food'], ['CHAMPION PIZZA', 'Food'],
    ['POPEYES #11360', 'Food'], ["POPEYE'S SUPPLEMENTS", 'Personal'], ['WYNN FITNESS CLUBS(MEADOW', 'Personal'],
    ['THE PADEL DISTRICT INC', 'Personal'], ['THE DISTRICT PADEL AND', 'Personal'], ['PLATOS CLOSET', 'Personal'],
    ['PAYPAL *STEAM GAMES 35314369001', 'Digital'], ['MOBIL @ 6507', 'Transport'],
    ['PETRO-CANADA 00480', 'Transport'], ['PETRO-CANADA 33635', 'Transport'], ['ESSO CIRCLE K', 'Transport'],
    ['CANNA CABANA MILCREEK', 'Goy'], ['CANNA CABANA WINSTON CHUR', 'Goy'],
    ['THE WOODS CANNABIS', 'Goy'], ["POP'S CANNABIS CO - DER", 'Goy'],
    ['PRIME VAPE COMPANY', 'Goy'], ['AUTO SPA', 'Transport'],
  ];
  for (const [description, expected] of examples) assert.equal(suggestExpenseCategory(description)?.category, expected, description);
  assert.equal(suggestExpenseCategory('  ｔｉｍ   ｈｏｒｔｏｎｓ  ')?.category, 'Food');
  assert.match(suggestExpenseCategory('MOBIL @ 6507')!.reason, /fuel or shop purchase/);
});

test('ambiguous merchants remain unclassified and explicit Other is not an unknown category', () => {
  for (const description of ['APPLE.COM/BILL', 'MICROSOFT#G173001297', 'NVIDIA CORPORATION', 'WAL-MART SUPERCENTER#3054', 'MINISO CANADA', 'IMPEX TRADING', '*RFBT-SOUTH COMMON MAL', 'SQ *SMASH', 'REFUEL TORONTO EATON C', 'COURTX', 'TORPRKAUT', '7 ELEVEN STORE #33000', '00790 MACS CONV. STORES', 'UBER CANADA', 'CAFEBOOK SOFTWARE']) {
    assert.equal(suggestExpenseCategory(description), null, description);
  }
  for (const category of ['', '  ', ' Uncategorized ', 'ＵＮＣＡＴＥＧＯＲＩＺＥＤ']) assert.equal(isUncategorized(category), true);
  for (const category of ['Other', 'Food', 'My category']) assert.equal(isUncategorized(category), false);
});

test('bank description spacing and truncation retain identifiable merchant categories', () => {
  const examples: [string, string][] = [
    ['MOBIL@ - 1234     _M', 'Transport'], ['PIONEER STN #123', 'Transport'],
    ['GOODLIFE CLUBS   MSP', 'Personal'], ['UBER CANADA/UBERTRIP TORONTO', 'Transport'],
    ['UBER *TRIP HELP.UBER.COM', 'Transport'], ['Spotify P4 7.22_V', 'Subscriptions'],
    ['GOOGLE *Destiny Rising g.co/helppay', 'Digital'], ['RABBA FINE FOOD _M', 'Food'],
    ['LOCAL SHAWARMA', 'Food'], ['LOCAL SUPERMARKET', 'Food'], ['PRESTO', 'Transport'],
    ['PRESTO FARE/EXAMPLE', 'Transport'], ['PRESTO MOBI _V', 'Transport'],
    ['PRESTO AUTO/EXAMPLE', 'Transport'], ['PRESTO APPL/EXAMPLE', 'Transport'],
  ];
  for (const [description, expected] of examples) assert.equal(suggestExpenseCategory(description)?.category, expected, description);
  for (const description of ['UBER CANADA/UBE _V', 'Uber Holdings Canada Inc.', 'GOOGLE *Google _V', 'GOOGLE *SERVICE _V', 'GOOGLE *YouTube _V', 'APPLE.COM/BILL', 'PIONEER ELECTRONICS', 'MOBIL SOFTWARE', 'PRESTO APPLIANCES', 'PAYPAL *UNKNOWN']) {
    assert.equal(suggestExpenseCategory(description), null, description);
  }
});

test('clear food merchants retain suggestions across processor, city and statement suffixes', () => {
  const descriptions = [
    'PITA & HUMMUS TORONTO', 'PITA AND HUMMUS TORONTO', 'Jabal Coffee Ho   _M', 'JABAL COFFEE HOUSE MISSISSAUGA',
    'USMANIA GRILLS    _M', 'CHAMPION DONAIR MISSISSAUGA', 'WATAN KABOB _M', 'LOCAL KEBAB TORONTO',
    'YASEENS SHAWARM _M', 'YASEENS SHAWARMA & GRIL MISSISSAUGA', 'COCO BUBBLE TEA ERINDALE MISSISSAUGA',
    'OSMOWS', "OSMOW'S", 'OSMOWS APP - HQ MISSISSAUGA', 'Lazeez L002', 'LAZEEZ SHAWARMA MISSISSAUGA',
    'I HEART BOBA', 'EGG CLUB UNION STATION TORONTO',
    'STARBUCKS 04608 TORONTO', 'SBUX 53982 METRO 100704 ETOBICOKE', 'SECOND CUP - 9486 MISSISSAUGA',
    'BASKIN ROBBINS _M', 'BASKIN-ROBBINS TORONTO', 'DAVES HOT CHICKEN TORONTO', 'DAVE’S HOT CHICKEN TORONTO',
    "WENDY'S MISSISSAUGA", 'WENDYS 6681 MISSISSAUGA', 'KFC/TB #1392 _M', 'KFC #1392 TORONTO',
    'FRESHCO #9611     _M', "LONGO'S # 15 TORONTO", 'RCSS #1024 OAKVILLE', 'NO FRILLS #123 TORONTO',
    'SQ *Jabal Coffee Ho _M', 'TST-PITA & HUMMUS TORONTO', 'PAYPAL *OSMOWS 4029357733',
    '  ｐｉｔａ  ＆  ｈｕｍｍｕｓ  ｔｏｒｏｎｔｏ  ',
  ];
  for (const description of descriptions) assert.equal(suggestExpenseCategory(description)?.category, 'Food', description);
});

test('parking operator descriptions need a full recognizable name or operator identifier', () => {
  for (const description of ['TORONTO PARKING AUTHORITY TORONTO', 'PARK INDIGO - NO CTO404 TORONTO', 'PARKING INDIGO TORONTO', 'IMPARK00090082U TORONTO', 'IMPARK 90082 TORONTO']) {
    assert.equal(suggestExpenseCategory(description)?.category, 'Transport', description);
  }
  for (const description of ['TORPRKAUT TORONTO', 'INDIGO BOOKS', 'INDIGO PARK APARTMENTS', 'IMPARKING SOFTWARE', 'PARK EQUIPMENT SALES']) {
    assert.equal(suggestExpenseCategory(description), null, description);
  }
});

test('mixed retailers and partial food words do not become food suggestions', () => {
  const descriptions = [
    'WAL-MART SUPERCENTER#1211 MISSISSAUGA', 'WALMART STORE # _M', 'DOLLARAMA # 553 _M', 'DOLLAR TREE CANADA #40264 AJAX',
    'AMAZON.CA', 'AMZN MKTPLACE', 'COSTCO WHOLESALE', 'CANADIAN TIRE #169 MISSISSAUGA', 'SHOPPERS DRUG M _M',
    'BEST BUY #977 _M', 'THE HOME DEPOT #7130 MISSISSAUGA', 'IKEA ETOBICOKE', 'CIRCLE-K #52265 _M', '7-ELEVEN #33491 TORONTO',
    'SARANGAN\'S NO F _M', 'METRO 854', 'COFFEE EQUIPMENT SALES', 'GRILL PARTS CANADA', 'LAZEEZ CONSULTING',
    'STARBUCKSWARE SOFTWARE', 'SBUX CONSULTING', 'FRESHCOAST CLOTHING', 'LONGORIA EQUIPMENT', 'RCSS SERVICES',
    'SHAWARM TECHNOLOGIES', 'PITA CONSULTING', 'JABAL HOLDINGS', 'WENDY SMITH DESIGN',
  ];
  for (const description of descriptions) assert.equal(suggestExpenseCategory(description), null, description);
});

test('Home and Expenses use the same category totals and refund treatment', () => {
  const data = state();
  data.transactions = [
    expense('food', 'Food & groceries'), expense('health', 'Health & fitness'), expense('interest', 'Interest'),
    expense('fuel-shop', 'Fuel & convenience'), expense('streaming', 'Subscriptions'), expense('software', 'Digital purchases'),
    expense('trip', 'Travel'), expense('cannabis', 'Goy'), expense('ticket', 'Social', 3221), expense('refund', 'Social', -3108), expense('review', 'Uncategorized'),
  ];
  const plan = buildExpensePlan(data, 'me', '2026-09', '2026-09-24');
  const home = spendingOverview(data, 'me', 'monthly', '2026-09-24');
  assert.deepEqual(home.rows.map(row => [row.limit.id, row.spentCents, row.transactionCount]), plan.rows.map(row => [row.limit.id, row.spentCents, row.transactionCount]));
  assert.equal(home.totalSpentCents, plan.recordedCents);
  assert.equal(plan.rows.find(row => row.key === 'social')?.spentCents, 113);
  assert.equal(plan.rows.find(row => row.key === 'fees')?.spentCents, 1000);
  assert.equal(plan.rows.find(row => row.key === 'trips')?.spentCents, 1000);
});

test('saved aliases override defaults without duplicate names or changing saved budgets', () => {
  const data = state();
  data.spendingLimits = [{ id: 'me:work', entityId: 'me', name: 'Work', aliases: ['Food', 'Food & groceries', 'Subscriptions', 'Interest'], color: '#ABCDEF', dailyCents: 0, weeklyCents: null, monthlyCents: 20000 }];
  const before = structuredClone(data);
  const limits = categoryLimits(data, 'me');
  const claimed = limits.flatMap(limit => [limit.name, ...limit.aliases]).map(value => value.toLowerCase());
  assert.equal(new Set(claimed).size, claimed.length);
  assert.deepEqual(data, before);
  for (const category of ['Food', 'Subscriptions', 'Interest']) assert.equal(expensePlanTransactionCategory(data, 'me', expense(category, category)), 'Work');
});

test('planned rent keeps Housing and a later explicit transaction correction is honored', () => {
  const data = state();
  data.obligations = [
    { id: 'rent', entityId: 'me', name: 'Rent', amountCents: 1000, dueDate: '2026-10-22', direction: 'out', recurrence: 'monthly', status: 'planned', accountId: 'bank', category: 'Housing' },
    { id: 'phone', entityId: 'me', name: 'Phone', amountCents: 1000, dueDate: '2026-10-22', direction: 'out', recurrence: 'monthly', status: 'planned', accountId: 'bank', category: 'Digital' },
  ];
  assert.equal(expensePlanTransactionCategory(data, 'me', expense('rent', 'Housing', 1000, 'Planned payment rent')), 'Housing');
  assert.equal(expensePlanTransactionCategory(data, 'me', expense('phone', 'Digital', 1000, 'Planned payment phone')), 'Bills');
  assert.equal(expensePlanTransactionCategory(data, 'me', expense('corrected', 'Career', 1000, 'Planned payment phone')), 'Career');
});

test('Goy retains legacy cannabis and vape category matches', () => {
  const data = state();
  for (const category of ['Cannabis & vape', 'Cannabis', 'Vape', 'Goy']) {
    assert.equal(expensePlanTransactionCategory(data, 'me', expense(category, category)), 'Goy');
  }
});

test('recorded expense categories survive later bill changes and removal', () => {
  const data = state();
  const bill: Obligation = { id: 'phone', entityId: 'me', name: 'Phone', amountCents: 1000, dueDate: '2026-10-22', direction: 'out', recurrence: 'monthly', status: 'planned', accountId: 'bank', category: 'Digital' };
  data.obligations = [bill];
  const payment = { ...expense('phone', 'Digital', 1000, 'Planned payment phone'), expenseCategory: plannedExpenseCategory(data, bill) };
  assert.equal(payment.expenseCategory, 'Bills');
  data.transactions = [payment];
  bill.category = 'Gym';
  bill.subscription = true;
  assert.equal(plannedExpenseCategory(data, bill), 'Subscriptions');
  assert.equal(expensePlanTransactionCategory(data, 'me', payment), 'Bills');
  data.obligations = [];
  const report = buildExpensePlan(data, 'me', '2026-09', '2026-09-24');
  assert.equal(report.rows.find(row => row.key === 'bills')?.spentCents, 1000);
  assert.equal(report.rows.find(row => row.key === 'digital')?.spentCents, 0);
  assert.equal(payment.category, 'Digital');
});

test('an explicit category correction overrides a planned expense snapshot', () => {
  const data = state();
  data.obligations = [{ id: 'phone', entityId: 'me', name: 'Phone', amountCents: 1000, dueDate: '2026-10-22', direction: 'out', recurrence: 'monthly', status: 'planned', accountId: 'bank', category: 'Digital', subscription: true }];
  const payment = { ...expense('phone', 'Digital', 1000, 'Planned payment phone'), expenseCategory: 'Digital' };
  assert.equal(expensePlanTransactionCategory(data, 'me', payment), 'Digital');
  payment.expenseCategory = 'Uncategorized';
  assert.equal(expensePlanTransactionCategory(data, 'me', payment), 'Other');
});

test('imported bill matches use their explicit link while preserving source and category overrides', () => {
  const data = state();
  data.obligations = [
    { id: 'phone', entityId: 'me', name: 'Phone', amountCents: 1000, dueDate: '2026-10-22', direction: 'out', recurrence: 'monthly', status: 'planned', accountId: 'bank', category: 'Digital' },
    { id: 'streaming', entityId: 'me', name: 'Streaming', amountCents: 1000, dueDate: '2026-10-22', direction: 'out', recurrence: 'monthly', status: 'planned', accountId: 'bank', category: 'Digital', subscription: true },
  ];
  const payment = { ...expense('imported', 'Digital', 1000, 'Original bank statement.pdf'), plannedPayment: { obligationId: 'streaming', dueDate: '2026-09-22' } };
  const before = structuredClone(payment);
  assert.equal(expensePlanTransactionCategory(data, 'me', payment), 'Subscriptions');
  assert.deepEqual(payment, before);
  assert.equal(expensePlanTransactionCategory(data, 'me', { ...payment, source: 'Planned payment phone' }), 'Subscriptions');
  assert.equal(expensePlanTransactionCategory(data, 'me', { ...payment, category: 'Career' }), 'Career');
  assert.equal(expensePlanTransactionCategory(data, 'me', { ...payment, expenseCategory: 'Digital' }), 'Digital');
  assert.equal(expensePlanTransactionCategory(data, 'me', { ...payment, expenseCategory: 'Uncategorized' }), 'Other');
  assert.equal(expensePlanTransactionCategory(data, 'another-owner', payment), 'Digital');
});

test('legacy health and fuel names use the combined categories without rewriting source records', () => {
  const data = state();
  data.transactions = [
    expense('gym', 'Gym'), expense('fitness', 'Health & fitness'), expense('medical', 'Medication'), expense('care', 'Personal care'),
    expense('gas', 'Fuel & convenience'), expense('transport', 'Transport'),
    { ...expense('health-snapshot', 'Digital'), expenseCategory: 'Gym' },
    { ...expense('fuel-snapshot', 'Uncategorized'), expenseCategory: 'Fuel & convenience' },
    expense('health-refund', 'Fitness', -500),
    { ...expense('correction', 'Gym'), expenseCategory: 'Career' },
  ];
  const before = structuredClone(data);
  const plan = buildExpensePlan(data, 'me', '2026-09', '2026-09-24');
  assert.equal(plan.rows.some(row => row.key === 'gym'), false);
  assert.equal(plan.rows.find(row => row.key === 'personal')?.spentCents, 4500);
  assert.equal(plan.rows.find(row => row.key === 'transport')?.spentCents, 3000);
  assert.equal(plan.rows.find(row => row.key === 'career')?.spentCents, 1000);
  assert.equal(plan.recordedCents, 8500);
  assert.equal(plan.rows.reduce((sum, row) => sum + row.spentCents, 0), 8500);
  assert.deepEqual(data, before);
});

test('saved Personal plans gain health aliases without replacing their name or monthly amounts', () => {
  const data = state();
  data.spendingLimits = [{ id: 'me:personal', entityId: 'me', name: 'Self care', aliases: ['haircut'], color: '#ABCDEF', dailyCents: 0, weeklyCents: 500, monthlyCents: 2000, monthlyAmounts: { '2026-09': null, '2026-10': 3000 } }];
  const before = structuredClone(data);
  const personal = categoryLimits(data, 'me').find(limit => limit.id === 'me:personal')!;
  assert.deepEqual({ ...personal, aliases: ['haircut'] }, data.spendingLimits[0]);
  assert.equal(expensePlanTransactionCategory(data, 'me', expense('health', 'Health & fitness')), 'Self care');
  assert.equal(expensePlanTransactionCategory(data, 'me', expense('gym', 'Gym')), 'Self care');
  assert.deepEqual(data, before);
});

test('explicit saved Gym and custom health plans retain their separate saved amounts and aliases', () => {
  const data = state();
  const gym = { id: 'me:gym', entityId: 'me', name: 'Gym', aliases: ['fitness'], color: '#112233', dailyCents: 0, weeklyCents: 500, monthlyCents: 3000, monthlyAmounts: { '2026-09': 5000, '2026-10': null } };
  const personal = { id: 'me:personal', entityId: 'me', name: 'Personal', aliases: ['haircut'], color: '#ABCDEF', dailyCents: null, weeklyCents: null, monthlyCents: 7000, monthlyAmounts: { '2026-09': 10000, '2026-10': 0 } };
  const treatment = { id: 'me:treatment', entityId: 'me', name: 'Treatment', aliases: ['medication', 'medical'], color: '#ABCDEF', dailyCents: null, weeklyCents: null, monthlyCents: null };
  data.spendingLimits = [gym, personal, treatment];
  const before = structuredClone(data);
  assert.deepEqual(categoryLimits(data, 'me').find(limit => limit.id === gym.id), gym);
  assert.deepEqual(categoryLimits(data, 'me').find(limit => limit.id === treatment.id), treatment);
  assert.equal(expensePlanTransactionCategory(data, 'me', expense('health', 'Medical')), 'Treatment');
  assert.equal(expensePlanTransactionCategory(data, 'me', expense('gym', 'Fitness')), 'Gym');
  assert.equal(buildExpensePlan(data, 'me', '2026-09', '2026-09-24').plannedCents, 15000);
  assert.equal(buildExpensePlan(data, 'me', '2026-10', '2026-09-24').plannedCents, 0);
  assert.deepEqual(data, before);
});

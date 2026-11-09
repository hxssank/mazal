import test from 'node:test';
import assert from 'node:assert/strict';
import { categoryReviewGroups, categoryReviewOptions, reverseCategoryChanges, selectedCategoryChanges } from './category-review.ts';
import { filterLedger } from './ledger.ts';
import type { AppState, Transaction } from './types.ts';

const transaction = (id:string,description:string,changes:Partial<Transaction>={}):Transaction => ({id,description,accountId:'card',toAccountId:null,kind:'expense',amountCents:1000,category:'Uncategorized',date:'2026-08-01',createdAt:'2026-08-01T12:00:00Z',source:'Statement',...changes});
function state(transactions:Transaction[]):AppState {
  return {workspace:'live',revision:1,entities:[{id:'personal',name:'Personal',kind:'personal',ownershipBps:10000},{id:'shop',name:'Shop',kind:'business',ownershipBps:5000}],accounts:[{id:'card',entityId:'personal',name:'Card',type:'debt',currency:'CAD',balanceCents:30000,reconciledAt:null},{id:'business',entityId:'shop',name:'Business',type:'cash',currency:'CAD',balanceCents:20000,reconciledAt:null}],transactions,obligations:[],reserves:[],positions:[],audit:[],lastBackupAt:null};
}

test('review groups billing references and repeated merchants, while keeping owners and differing merchants separate',()=>{
  const data=state([transaction('apple1','APPLE.COM/BILL TORONTO'),transaction('apple2','APPLE.COM/BILL 866-712-7753',{amountCents:-100}),transaction('apple3','APPLE.COM/BILL TORONTO',{accountId:'business'}),transaction('ms1','MICROSOFT#G123456789 HALIFAX'),transaction('ms2','MICROSOFT#G987654321 HALIFAX'),transaction('walmart','WAL-MART SUPERCENTER#3054 MEADOWVALE'),transaction('walmart-other','WAL-MART SUPERCENTER#3055 MISSISSAUGA'),transaction('other','APPLE.COM/BILL TORONTO',{category:'Other'}),transaction('income','APPLE.COM/BILL TORONTO',{kind:'income'})]);
  const groups=categoryReviewGroups(data,data.transactions);
  assert.equal(groups.length,4);
  const apple=groups.find(group=>group.merchant==='Apple.com/bill'&&group.ownerId==='personal')!;
  assert.deepEqual(apple.rows.map(row=>row.id),['apple1','apple2']);
  assert.equal(apple.amountCents,900);
  assert.equal(groups.find(group=>group.merchant==='Microsoft')!.rows.length,2);
  assert.equal(groups.find(group=>group.merchant==='Walmart')!.rows.length,2);
  assert.equal(groups.reduce((sum,group)=>sum+group.rows.length,0),7);
});

test('merged statement names retain original rows, refunds, dates and source text',()=>{
  const data=state([
    transaction('older','FRESHCO #9611 MISSISSAUGA',{date:'2026-07-31',source:'Statement page 4'}),
    transaction('newer-a','FRESHCO #9611     _M',{date:'2026-08-02',amountCents:-300,createdAt:'2026-08-04T10:00:00Z'}),
    transaction('newer-z','FreshCo',{date:'2026-08-02',amountCents:200,createdAt:'2026-08-04T10:00:00Z'}),
    transaction('imported-later','FreshCo',{date:'2026-08-02',amountCents:0,createdAt:'2026-08-05T10:00:00Z'}),
  ]);
  const before=structuredClone(data);
  const groups=categoryReviewGroups(data,data.transactions);
  assert.equal(groups.length,1);
  assert.equal(groups[0].merchant,'FreshCo');
  assert.equal(groups[0].amountCents,900);
  assert.deepEqual(groups[0].rows.map(row=>row.id),['imported-later','newer-a','newer-z','older']);
  assert.deepEqual(new Set(groups[0].variants),new Set(before.transactions.map(row=>row.description)));
  assert.deepEqual(categoryReviewGroups(data,[...data.transactions].reverse()),groups);
  assert.deepEqual(data,before);
});

test('category review omits canceled entries but retains their replacement and genuine refunds',()=>{
  const data=state([
    transaction('original','Original charge'),
    transaction('reversal','Reversal: Original charge',{amountCents:-1000,reversalOf:'original'}),
    transaction('replacement','Corrected charge',{amountCents:900,replacesId:'original'}),
    transaction('refund','Store refund',{amountCents:-200,refundOf:'replacement'}),
    transaction('removed','Removed charge'),
    transaction('remove-reversal','Reversal: Removed charge',{amountCents:-1000,reversalOf:'removed'}),
  ]);
  const original=structuredClone(data);
  assert.deepEqual(categoryReviewGroups(data,data.transactions).flatMap(group=>group.rows.map(row=>row.id)).sort(),['refund','replacement']);
  assert.deepEqual(categoryReviewGroups(data,[data.transactions[0]]),[],'A reversal outside the filtered rows still cancels its original');
  assert.deepEqual(data,original);
});

test('merchant aliases use agreeing history within the same owner and leave conflicts without a suggestion',()=>{
  const data=state([
    transaction('personal-pending','FRESHCO #9611     _M'),
    transaction('business-pending','FreshCo',{accountId:'business'}),
    transaction('personal-history','FRESHCO #9611 MISSISSAUGA',{category:'Food'}),
    transaction('business-history','FRESHCO #9611 MISSISSAUGA',{accountId:'business',category:'Career'}),
  ]);
  let groups=categoryReviewGroups(data,data.transactions);
  assert.equal(groups.length,2);
  assert.equal(groups.find(group=>group.ownerId==='personal')?.suggestion?.category,'Food');
  assert.equal(groups.find(group=>group.ownerId==='shop')?.suggestion?.category,'Career');
  data.transactions.push(transaction('conflict','FreshCo',{category:'Personal',amountCents:-100}));
  groups=categoryReviewGroups(data,data.transactions);
  assert.equal(groups.find(group=>group.ownerId==='personal')?.suggestion,null);
  assert.equal(groups.find(group=>group.ownerId==='shop')?.suggestion?.category,'Career');
});

test('processor and currency variants use the same history identity without mutating categories',()=>{
  const data=state([
    transaction('github-pending','GITHUB, INC. GITHUB.COM FOREIGN CURRENCY 10.00 USD @ EXCHANGE RATE 1.42699'),
    transaction('github-history','GITHUB, INC. GITHUB.COM FOREIGN CURRENCY 10.00 USD @ EXCHANGE RATE 1.44799',{category:'Subscriptions'}),
    transaction('chatgpt-pending','PAYPAL *OPENAI *CHATGPT S 4029357733'),
    transaction('chatgpt-history','OPENAI *CHATGPT S',{category:'Digital',expenseCategory:'Subscriptions'}),
    transaction('api-history','OPENAI API',{category:'Career'}),
  ]);
  const before=structuredClone(data);
  const groups=categoryReviewGroups(data,data.transactions);
  assert.equal(groups.length,2);
  assert.ok(groups.every(group=>group.suggestion?.category==='Subscriptions'));
  assert.deepEqual(data,before);
});

test('merged groups reject unsafe cent totals',()=>{
  const data=state([transaction('one','Lazeez L002',{amountCents:Number.MAX_SAFE_INTEGER}),transaction('two','Lazeez L002 Mississauga',{amountCents:1})]);
  assert.throws(()=>categoryReviewGroups(data,data.transactions),/whole cents/);
});

test('review saves only visible selected rows and preserves expected categories for stale-write checks',()=>{
  const data=state([transaction('visible','Merchant'),transaction('older','Merchant',{date:'2026-07-01'}),transaction('business','Merchant',{accountId:'business'}),transaction('different','Other shop'),transaction('edited','Merchant',{category:'Food'})]);
  const rows=filterLedger(data,{scope:'personal',month:'2026-08',accountId:'card',kind:'expense',query:'Merchant'});
  const selections=Object.fromEntries(data.transactions.map(row=>[row.id,{id:row.id,expectedCategory:'Uncategorized',category:'Digital'}]));
  assert.deepEqual(selectedCategoryChanges(rows,selections),[{id:'visible',expectedCategory:'Uncategorized',category:'Digital',expectedExpenseCategory:null,expenseCategory:'Digital'}]);
  assert.deepEqual(categoryReviewGroups(data,rows).flatMap(group=>group.rows.map(row=>row.id)),['visible']);
  assert.deepEqual(reverseCategoryChanges(selectedCategoryChanges(rows,selections)),[{id:'visible',expectedCategory:'Digital',category:'Uncategorized',expectedExpenseCategory:'Digital',expenseCategory:null}]);
});

test('category undo restores the original reporting group and checks the group being replaced',()=>{
  const row=transaction('bill','Bill',{expenseCategory:'Bills'});
  const changes=selectedCategoryChanges([row],{bill:{id:'bill',expectedCategory:'Uncategorized',category:'Gym'}});
  assert.deepEqual(changes,[{id:'bill',expectedCategory:'Uncategorized',category:'Gym',expectedExpenseCategory:'Bills',expenseCategory:'Gym'}]);
  assert.deepEqual(reverseCategoryChanges(changes),[{id:'bill',expectedCategory:'Gym',category:'Uncategorized',expectedExpenseCategory:'Gym',expenseCategory:'Bills'}]);
  assert.deepEqual(reverseCategoryChanges([{id:'legacy',expectedCategory:'',category:'Food'}]),[{id:'legacy',expectedCategory:'Food',category:'Uncategorized',expenseCategory:null}]);
});

test('a saved merchant category is suggested only within the same owner and only when prior entries agree',()=>{
  const data=state([transaction('pending','  Merchant  '),transaction('prior','merchant',{category:'Career'}),transaction('business','Merchant',{accountId:'business',category:'Food'})]);
  assert.equal(categoryReviewGroups(data,data.transactions)[0].suggestion?.category,'Career');
  data.transactions.push(transaction('conflict','Merchant',{category:'Personal'}));
  assert.equal(categoryReviewGroups(data,data.transactions)[0].suggestion,null);
  data.transactions=[transaction('ambiguous','APPLE.COM/BILL TORONTO')];
  assert.equal(categoryReviewGroups(data,data.transactions)[0].suggestion,null);
});

test('a selected category retains its opened reporting snapshot after newer data arrives',()=>{
  const row=transaction('pending','Merchant',{expenseCategory:'Bills'});
  const selected={id:row.id,expectedCategory:row.category,category:'Digital',expectedExpenseCategory:null};
  assert.equal(selectedCategoryChanges([row],{pending:selected})[0].expectedExpenseCategory,null);
  assert.equal(selectedCategoryChanges([row],{pending:{...selected,expectedExpenseCategory:'Subscriptions'}})[0].expectedExpenseCategory,'Subscriptions');
});

test('10,000 transactions use one merchant-history pass instead of rescanning for every group',()=>{
  let categoryReads=0;
  const transactions=Array.from({length:10000},(_,index)=>{
    const category=index<5000?'Uncategorized':'Food';
    const row=transaction(String(index),`Merchant ${index%5000}`);
    Object.defineProperty(row,'category',{enumerable:true,get:()=>{categoryReads++;return category;}});
    return row;
  });
  const data=state(transactions);
  const groups=categoryReviewGroups(data,transactions);
  assert.equal(groups.length,5000);
  assert.ok(groups.every(group=>group.rows.length===1&&group.suggestion?.category==='Food'));
  assert.ok(categoryReads<=transactions.length*3,`Merchant grouping read ${categoryReads} categories for ${transactions.length} transactions.`);
});

test('category options contain one choice per canonical category despite historical aliases',()=>{
  const data=state([
    transaction('gas','Gas',{category:'Fuel & convenience'}),
    transaction('gym','Gym',{category:'Gym'}),
    transaction('health','Health',{category:'Health & fitness'}),
    transaction('care','Care',{category:'Personal care'}),
  ]);
  const before=structuredClone(data);
  const options=categoryReviewOptions(data,'personal','Fuel & convenience');
  assert.equal(options.length,14);
  assert.ok(options.includes('Transport'));
  assert.ok(options.includes('Personal'));
  for(const alias of ['Fuel & convenience','Gym','Health & fitness','Personal care']) assert.equal(options.includes(alias),false);
  assert.deepEqual(categoryReviewOptions(data,'personal','Health & fitness'),options);
  assert.deepEqual(data,before);
});

test('canonical options retain explicit custom category names and scope them by owner',()=>{
  const data=state([]);
  data.spendingLimits=[{id:'my-fuel',entityId:'personal',name:'Fuel & convenience',aliases:['fleet fuel'],color:'#ABCDEF',dailyCents:null,weeklyCents:null,monthlyCents:5000},{id:'shop-pets',entityId:'shop',name:'Pets',aliases:['vet'],color:'#ABCDEF',dailyCents:null,weeklyCents:null,monthlyCents:null}];
  const options=categoryReviewOptions(data,'personal');
  assert.ok(options.includes('Fuel & convenience'));
  assert.ok(options.includes('Transport'));
  assert.equal(options.includes('fleet fuel'),false);
  assert.equal(options.includes('Pets'),false);
});

test('merchant history treats legacy aliases as the same category and honors reporting corrections',()=>{
  const data=state([
    transaction('gas-pending','Gas station'),transaction('gas-old','Gas station',{category:'Fuel & convenience'}),transaction('gas-new','Gas station',{category:'Transport'}),
    transaction('gym-pending','Gym'),transaction('gym-old','Gym',{category:'Gym'}),transaction('gym-new','Gym',{category:'Personal care'}),
    transaction('corrected-pending','Merchant'),transaction('corrected-old','Merchant',{category:'Gym',expenseCategory:'Career'}),
  ]);
  const before=structuredClone(data);
  const groups=categoryReviewGroups(data,data.transactions);
  assert.equal(groups.find(group=>group.merchant==='Gas station')?.suggestion?.category,'Transport');
  assert.equal(groups.find(group=>group.merchant==='Gym')?.suggestion?.category,'Personal');
  assert.equal(groups.find(group=>group.merchant==='Merchant')?.suggestion?.category,'Career');
  assert.deepEqual(data,before);
});

test('saved names separate purchases behind the same bank merchant and retain notes and originals',()=>{
  const data=state([
    transaction('food','PAYPAL GENERIC',{displayName:'FreshCo',note:'Weekly groceries'}),
    transaction('work','PAYPAL GENERIC',{displayName:'Work supplies'}),
    transaction('unknown','PAYPAL GENERIC'),
    transaction('history','OTHER BANK TEXT',{displayName:'FreshCo',category:'Food'}),
  ]);
  const before=structuredClone(data),groups=categoryReviewGroups(data,data.transactions);
  assert.equal(groups.length,3);const food=groups.find(group=>group.merchant==='FreshCo')!;
  assert.equal(food.suggestion?.category,'Food');assert.deepEqual(food.variants,['PAYPAL GENERIC']);
  assert.equal(food.rows[0].note,'Weekly groceries');assert.deepEqual(data,before);
});

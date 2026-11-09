import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewMerchant } from './merchant-names.ts';

test('observed statement variants resolve to explicit merchant names',()=>{
  const cases: [string,string[]][] = [
    ['FreshCo',['FRESHCO #9611     _M','FRESHCO #9611 MISSISSAUGA']],
    ['Walmart',['WAL-MART #1211    _M','WAL-MART SUPERCENTER#1211 MISSISSAUGA','WAL-MART SUPERCENTER#3106 TORONTO','WALMART STORE #','WALMART STORE # _M']],
    ['The Home Depot',['THE HOME DEPOT _M','THE HOME DEPOT #7130 MISSISSAUGA']],
    ['SL Meadowvale',['SL Meadowvale _M','SL Meadowvale Mississauga']],
    ['Lazeez',['Lazeez L002','Lazeez L002 Mississauga']],
    ['Claude.ai',['CLAUDE.AI 316.40_V','CLAUDE.AI 31.64_V']],
    ['GitHub',['GITHUB, INC. GITHUB.COM FOREIGN CURRENCY 10.00 USD @ EXCHANGE RATE 1.42699','GITHUB, INC. GITHUB.COM FOREIGN CURRENCY 10.00 USD @ EXCHANGE RATE 1.44799']],
    ['Dollarama',['DOLLARAMA # 553 _M','DOLLARAMA # 553 MISSISSAUGA']],
    ["Osmow's",["OSMOW'S",'OSMOWS','OSMOWS APP - HQ MISSISSAUGA']],
    ['One Plant Yonge',['ONE PLANT YONGE _M','One Plant Yonge St. TORONTO','ONE PLANT YONGE ST TORONTO']],
    ['Gateway Newsstand',['GATEWAY NEWSSTA','GATEWAY NEWSSTAND 146 TORONTO']],
    ['Habibz Corner',['SQ *HABIBZ CORN','SQ *HABIBZ CORN _M','SQ *HABIBZ CORNER Mississauga']],
    ['Winston AI',['WINSTON AI _V','GOWINSTON.AI DE _V']],
    ['Steam games',['Steam Purc 84.74_V','PAYPAL *STEAM GAMES 35314369001']],
    ['eBay',['eBay O*05-14650-81720 Toronto','eBay O*06-14548-04342 INTERNET','eBay O*14- 96.12_V']],
    ['Starbucks',['STARBUCKS 04608 TORONTO','STARBUCKS 16201 MISSISSAUGA','SBUX 53982 METRO 100704 ETOBICOKE']],
  ];
  for(const [expected,variants] of cases)for(const variant of variants)assert.equal(reviewMerchant(variant),expected,variant);
});

test('only recognized statement metadata and payment wrappers are removed',()=>{
  for(const suffix of [' _M','_V',' _T'])assert.equal(reviewMerchant(`  Merchant  one ${suffix}`),'Merchant one');
  assert.equal(reviewMerchant('PAYPAL *OPENAI *CHATGPT S 4029357733'),'OPENAI *CHATGPT S');
  assert.equal(reviewMerchant('SQ *MICAH PICKS VINTAGE Toronto'),'MICAH PICKS VINTAGE Toronto');
  assert.equal(reviewMerchant('STUDYHELP.IO STUDYHELP.IO FOREIGN CURRENCY 55.55 USD @ EXCHANGE RATE 1.42124'),'STUDYHELP.IO STUDYHELP.IO');
  for(const name of ['Merchant one_A','Merchant 4029357733','PAYPAL MERCHANT','Square Garden','Merchant FOREIGN CURRENCY PRINT','Merchant 12.34','PAYPAL *'])assert.equal(reviewMerchant(name),name);
});

test('shared prefixes do not merge products, unknown truncations or unrelated numbered merchants',()=>{
  const names=[
    'APPLE STORE #R350 MISSISSAUGA','APPLE.COM/BILL TORONTO',
    'UBER CANADA/UBEREATS TORONTO','UBER *TRIP HELP.UBER.COM Toronto','UBER CANADA/UBE _V','Uber Holdings Canada Inc. Toronto',
    'ANTHROPIC* CLAUDE SUB ANTHROPIC.CO','ANTHROPIC* 158.20_V','CLAUDE.AI 31.64_V',
    'PAYPAL *OPENAI *CHATGPT S 4029357733','OPENAI API',
    'Merchant 1','Merchant 2','METRO 854','METRO TRANSIT',
    'Walmart Pharmacy','WALMART STORE #',
    'GitHub Copilot','GITHUB, INC. GITHUB.COM',
  ];
  assert.equal(new Set(names.map(reviewMerchant)).size,names.length);
  assert.equal(reviewMerchant('UBER CANADA/UBEREATS'),'Uber Eats');
  assert.equal(reviewMerchant('UBER CANADA/UBERTRIP TORONTO'),'Uber rides');
});

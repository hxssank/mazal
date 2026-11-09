import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultStatementMapping,mapStatementCSV,csvHeaders,validateStatementMapping} from './statement-mapping.ts';
test('bank column mapping preserves quoted descriptions and requires explicit one-date and polarity choices',()=>{
  const source='Date,Details,Withdrawals,Deposits\n10/01/2026,"Coffee, shop",4.50,\n10/02/2026,Pay,,"1,200.25"';
  const mapping={...defaultStatementMapping(csvHeaders(source)),mode:'split' as const,dateFormat:'mdy' as const};
  assert.throws(()=>mapStatementCSV(source,mapping),/required column/);
  const rows=mapStatementCSV(source,{...mapping,sameDate:true});
  assert.equal(rows[0].description,'Coffee, shop');assert.equal(rows[0].amountCents,-450);assert.equal(rows[1].amountCents,120025);assert.equal(rows[0].transactionDate,'2026-10-01');
  assert.equal(mapStatementCSV(source,{...mapping,sameDate:true,sign:'invert'})[0].amountCents,450);
});
test('mapping rejects malformed currency, ambiguous double amounts, duplicate column assignments and invalid dates',()=>{
  const template='Date,Details,Debit,Credit\n';
  const mapping={...defaultStatementMapping(csvHeaders(template+'2026-10-01,Shop,1,0')),mode:'split' as const,sameDate:true};
  for(const row of ['2026-10-01,Shop,10,20','2026-10-01,Shop,"12,34",0','2026-02-30,Shop,10,0'])assert.throws(()=>mapStatementCSV(template+row,mapping));
  assert.throws(()=>mapStatementCSV(template+'2026-10-01,Shop,10,0',{...mapping,description:mapping.transactionDate}),/different column/);
});
test('saved mappings reject malformed modes, dates, signs, flags and column indexes',()=>{
  const mapping={...defaultStatementMapping(['Date','Description','Amount']),sameDate:true};
  assert.deepEqual(validateStatementMapping(mapping),mapping);
  for(const change of [{mode:'other'},{dateFormat:'other'},{sign:'other'},{sameDate:'false'},{amount:1.5},{amount:-1},{description:0},{unknown:true}])assert.throws(()=>validateStatementMapping({...mapping,...change}));
  for(const value of [null,[],{},'mapping'])assert.throws(()=>validateStatementMapping(value));
  assert.throws(()=>csvHeaders('Date,Description,Amount\n2026-01-01,Shop'),/same number of columns/);
});

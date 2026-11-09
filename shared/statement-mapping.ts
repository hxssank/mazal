import { parseCSVRecords } from './csv.ts';
import { parseStatementCSV } from './statement-csv.ts';
import type { StatementSourceRow } from './types.ts';
export interface StatementMapping { transactionDate:number; postingDate:number; description:number; amount:number; debit:number; credit:number; mode:'signed'|'split'; dateFormat:'ymd'|'mdy'|'dmy'; sign:'as-is'|'invert'; sameDate:boolean }
export function validateStatementMapping(value:unknown):StatementMapping {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Choose a valid CSV column mapping.');
  const raw=value as Record<string,unknown>;
  const columns=['transactionDate','postingDate','description','amount','debit','credit'] as const;
  const fields=new Set<string>([...columns,'mode','dateFormat','sign','sameDate']);
  if(Object.keys(raw).some(key=>!fields.has(key))||columns.some(key=>!Number.isSafeInteger(raw[key])||Number(raw[key])< -1)||typeof raw.mode!=='string'||!['signed','split'].includes(raw.mode)||typeof raw.dateFormat!=='string'||!['ymd','mdy','dmy'].includes(raw.dateFormat)||typeof raw.sign!=='string'||!['as-is','invert'].includes(raw.sign)||typeof raw.sameDate!=='boolean')throw new Error('Choose a valid CSV column mapping.');
  const required=[raw.transactionDate,raw.description,...(raw.sameDate?[]:[raw.postingDate]),...(raw.mode==='signed'?[raw.amount]:[raw.debit,raw.credit])];
  if(required.some(index=>Number(index)<0))throw new Error('Choose every required column.');
  if(new Set(required).size!==required.length)throw new Error('Each field needs a different column. For a file with one date, confirm that explicitly.');
  return {transactionDate:Number(raw.transactionDate),postingDate:Number(raw.postingDate),description:Number(raw.description),amount:Number(raw.amount),debit:Number(raw.debit),credit:Number(raw.credit),mode:raw.mode as StatementMapping['mode'],dateFormat:raw.dateFormat as StatementMapping['dateFormat'],sign:raw.sign as StatementMapping['sign'],sameDate:raw.sameDate};
}
export function csvHeaders(text:string):string[] {
  const records=parseCSVRecords(text.replace(/^\uFEFF/,''));
  if(records.length<2)throw new Error('The CSV needs a header and at least one transaction.');
  const headers=records[0].map(item=>item.trim());
  if(headers.some(item=>!item)||new Set(headers.map(item=>item.toLowerCase())).size!==headers.length)throw new Error('Every CSV column needs a unique header.');
  if(records.slice(1).some(record=>record.length!==headers.length))throw new Error('Every CSV row must contain the same number of columns as the header.');
  return headers;
}
export function defaultStatementMapping(headers:string[]):StatementMapping {
  const names=headers.map(item=>item.toLowerCase().replace(/[^a-z]/g,''));
  const find=(...aliases:string[])=>names.findIndex(name=>aliases.includes(name));
  return {transactionDate:find('transactiondate','date'),postingDate:find('postingdate','posteddate'),description:find('description','details','transactiondescription'),amount:find('amount'),debit:find('debit','debits','withdrawal','withdrawals'),credit:find('credit','credits','deposit','deposits'),mode:'signed',dateFormat:'ymd',sign:'as-is',sameDate:false};
}
function normalizeAmount(value:string,row:number):string {
  const trimmed=value.trim().replace(/^(?:CAD\s*|\$)/i,'');
  const raw=/^\(.*\)$/.test(trimmed)?`-${trimmed.slice(1,-1)}`:trimmed;
  if(!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(raw))throw new Error(`Row ${row}: amount must use a decimal point and at most two decimal places.`);
  return raw.replaceAll(',','');
}
export function mapStatementCSV(text:string,mapping:StatementMapping):StatementSourceRow[] {
  mapping=validateStatementMapping(mapping);
  const records=parseCSVRecords(text.replace(/^\uFEFF/,'')),headers=csvHeaders(text);
  const required=[mapping.transactionDate,mapping.description,...(mapping.sameDate?[]:[mapping.postingDate]),...(mapping.mode==='signed'?[mapping.amount]:[mapping.debit,mapping.credit])];
  if(required.some(index=>!Number.isInteger(index)||index<0||index>=headers.length))throw new Error('Choose every required column.');
  if(new Set(required).size!==required.length)throw new Error('Each field needs a different column. For a file with one date, confirm that explicitly.');
  const date=(raw:string,row:number)=>{
    const value=raw.trim();
    if(mapping.dateFormat==='ymd')return value;
    const parts=value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if(!parts)throw new Error(`Row ${row}: date does not match the selected format.`);
    return `${parts[3]}-${(mapping.dateFormat==='mdy'?parts[1]:parts[2]).padStart(2,'0')}-${(mapping.dateFormat==='mdy'?parts[2]:parts[1]).padStart(2,'0')}`;
  };
  const quote=(value:string)=>`"${value.replaceAll('"','""')}"`;
  const mapped=records.slice(1).map((record,index)=>{
    const row=index+2;if(record.length!==headers.length)throw new Error(`Row ${row}: column count differs from the header.`);
    let value:string;
    if(mapping.mode==='signed')value=normalizeAmount(record[mapping.amount],row);
    else {
      const debit=record[mapping.debit].trim(),credit=record[mapping.credit].trim();
      const normalizedDebit=debit?normalizeAmount(debit,row):'0',normalizedCredit=credit?normalizeAmount(credit,row):'0';
      if(normalizedDebit.startsWith('-')||normalizedCredit.startsWith('-'))throw new Error(`Row ${row}: debit and credit columns must contain positive amounts.`);
      if(Number(normalizedDebit)!==0&&Number(normalizedCredit)!==0)throw new Error(`Row ${row}: both debit and credit have amounts. Review this row before importing.`);
      value=Number(normalizedDebit)!==0?`-${normalizedDebit.replace(/^\+/,'')}`:normalizedCredit;
    }
    if(mapping.sign==='invert')value=value.startsWith('-')?value.slice(1):`-${value.replace(/^\+/,'')}`;
    return [date(record[mapping.transactionDate],row),date(record[mapping.sameDate?mapping.transactionDate:mapping.postingDate],row),record[mapping.description],value].map(quote).join(',');
  });
  return parseStatementCSV(['TransactionDate,PostingDate,Description,Amount',...mapped].join('\n'));
}

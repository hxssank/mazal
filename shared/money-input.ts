interface MoneyInputOptions {
  invalidMessage:string;
  rangeMessage:string;
  signed?:boolean;
  leadingDecimal?:boolean;
  trim?:boolean;
  maxCents?:number;
}

export function parseMoneyCents(value:string, options:MoneyInputOptions):number {
  const raw = options.trim === false ? value : value.trim();
  const unsigned = options.signed && raw.startsWith('-') ? raw.slice(1) : raw;
  const pattern = options.leadingDecimal ? /^(?:\d+|\d*\.\d{1,2})$/ : /^\d+(?:\.\d{1,2})?$/;
  if (!pattern.test(unsigned)) throw new Error(options.invalidMessage);
  const [whole, fraction = ''] = unsigned.split('.');
  const magnitude = BigInt(whole || '0') * 100n + BigInt(fraction.padEnd(2, '0'));
  if (magnitude > BigInt(options.maxCents ?? Number.MAX_SAFE_INTEGER)) throw new Error(options.rangeMessage);
  return Number(raw.startsWith('-') ? -magnitude : magnitude);
}

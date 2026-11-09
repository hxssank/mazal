const merchantAliases: { pattern: RegExp; name: string }[] = [
  { pattern: /^APPLE\.COM\/BILL(?:\s.*)?$/i, name: 'Apple.com/bill' },
  { pattern: /^MICROSOFT#[A-Z]\d+(?: HALIFAX| MSBILL\.INFO)?$/i, name: 'Microsoft' },
  { pattern: /^FRESHCO(?: #\s*\d+)?(?: MISSISSAUGA)?$/i, name: 'FreshCo' },
  { pattern: /^WAL-?MART(?: (?:SUPERCENTER|STORE))?(?:\s*#\s*\d*)?(?: MISSISSAUGA| MEADOWVALE| TORONTO)?$/i, name: 'Walmart' },
  { pattern: /^(?:THE )?HOME DEPOT(?: #\d+)?(?: MISSISSAUGA)?$/i, name: 'The Home Depot' },
  { pattern: /^SL MEADOWVALE(?: MISSISSAUGA)?$/i, name: 'SL Meadowvale' },
  { pattern: /^LAZEEZ(?: L\d+)?(?: MISSISSAUGA)?$/i, name: 'Lazeez' },
  { pattern: /^CLAUDE\.AI(?: \d+\.\d{2})?$/i, name: 'Claude.ai' },
  { pattern: /^ANTHROPIC\*(?: \d+\.\d{2})?$/i, name: 'Anthropic' },
  { pattern: /^GITHUB(?:,? INC\.?)?(?: GITHUB\.COM)?$/i, name: 'GitHub' },
  { pattern: /^DOLLARAMA(?: #\s*\d+)?(?: MISSISSAUGA)?$/i, name: 'Dollarama' },
  { pattern: /^OSMOW'?S(?: APP - HQ)?(?: MISSISSAUGA)?$/i, name: "Osmow's" },
  { pattern: /^ONE PLANT YONGE(?: ST\.?)?(?: TORONTO)?$/i, name: 'One Plant Yonge' },
  { pattern: /^GATEWAY NEWSSTA(?:ND(?: \d+)?(?: TORONTO)?)?$/i, name: 'Gateway Newsstand' },
  { pattern: /^HABIBZ CORN(?:ER(?: MISSISSAUGA)?)?$/i, name: 'Habibz Corner' },
  { pattern: /^(?:WINSTON AI|GOWINSTON\.AI DE)$/i, name: 'Winston AI' },
  { pattern: /^STEAM(?: GAMES| PURC \d+\.\d{2})$/i, name: 'Steam games' },
  { pattern: /^EBAY O\*(?:\d{2}-\d{5}-\d{5}(?: TORONTO| INTERNET)?|\d{2}- \d+\.\d{2})$/i, name: 'eBay' },
  { pattern: /^STARBUCKS(?: \d+)?(?: MISSISSAUGA| TORONTO)?$|^SBUX \d+ METRO \d+ ETOBICOKE$/i, name: 'Starbucks' },
  { pattern: /^UBER CANADA\/UBEREATS(?: TORONTO)?$|^UBER EATS$/i, name: 'Uber Eats' },
  { pattern: /^UBER CANADA\/UBERTRIP(?: TORONTO)?$|^UBER \*TRIP HELP\.UBER\.COM(?: TORONTO)?$/i, name: 'Uber rides' },
];

export function reviewMerchant(description: string): string {
  const original = description.normalize('NFKC').trim().replace(/\s+/g, ' ');
  let name = original;
  name = name.replace(/\s+FOREIGN CURRENCY [+-]?[\d,]+(?:\.\d+)? [A-Z]{3} @ EXCHANGE RATE \d+(?:\.\d+)?$/i, '');
  name = name.replace(/\s*_[MVT]$/i, '').trim();
  const paypal = /^PAYPAL\s*\*/i.test(name);
  name = name.replace(/^(?:PAYPAL|SQ|SQUARE)\s*\*\s*/i, '');
  if (paypal) name = name.replace(/\s+(?:4029357733|35314369001)$/, '');
  return merchantAliases.find(alias => alias.pattern.test(name))?.name ?? (name || original);
}

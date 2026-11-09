import type { AppState, Obligation, SpendingLimit, Transaction } from './types.ts';

export interface CategoryTemplate { key: string; name: string; label: string; examples: string; aliases: string[]; color: string }

const healthAliases = ['gym', 'gym membership', 'fitness', 'health & fitness', 'supplements', 'health', 'medication', 'pharmacy', 'dental', 'medical'];

export const expenseCategoryTemplates: CategoryTemplate[] = [
  { key: 'housing', name: 'Housing', label: 'Housing & family', examples: 'Rent, household needs, family support', aliases: ['housing', 'rent', 'family', 'family support'], color: '#B7A3CC' },
  { key: 'bills', name: 'Bills', label: 'Bills', examples: 'Utilities, phone, internet, insurance', aliases: ['bills', 'utilities', 'electricity', 'water', 'tenant insurance', 'phone', 'mobile', 'internet', 'broadband'], color: '#A4B8D9' },
  { key: 'food', name: 'Food', label: 'Food & groceries', examples: 'Groceries, meal plans, takeout, coffee', aliases: ['groceries', 'food & drink', 'dining', 'restaurants', 'coffee'], color: '#E8B975' },
  { key: 'transport', name: 'Transport', label: 'Transport', examples: 'Gas stations, transit, parking, car insurance', aliases: ['transportation', 'gas', 'fuel', 'fuel & convenience', 'parking', 'transit', 'car', 'car insurance', 'auto insurance', 'car maintenance', 'rideshare'], color: '#84B9DF' },
  { key: 'personal', name: 'Personal', label: 'Personal care', examples: 'Health, gym, haircuts, toiletries, clothes', aliases: ['personal', 'clothing', 'clothes', 'toiletries', 'haircut', 'haircuts', 'grooming', 'gifts', ...healthAliases], color: '#C8AD9A' },
  { key: 'subscriptions', name: 'Subscriptions', label: 'Subscriptions', examples: 'Streaming, memberships, recurring apps', aliases: ['subscriptions', 'subscription', 'streaming', 'apps', 'membership', 'memberships'], color: '#B3A0ED' },
  { key: 'digital', name: 'Digital', label: 'Digital purchases', examples: 'Software, games, one-off digital purchases', aliases: ['digital purchase', 'digital purchases', 'software', 'games'], color: '#ACA7DC' },
  { key: 'career', name: 'Career', label: 'Career & learning', examples: 'Courses, books, exams, work tools', aliases: ['career', 'learning', 'education', 'courses', 'books', 'exams', 'work tools'], color: '#9DB4BB' },
  { key: 'social', name: 'Social', label: 'Social', examples: 'Events, entertainment, nights out', aliases: ['social', 'entertainment', 'events', 'movies', 'concerts', 'going out'], color: '#C79EBE' },
  { key: 'trips', name: 'Trips', label: 'Trips', examples: 'Flights, hotels, weekends away', aliases: ['travel', 'trips', 'vacation', 'holidays', 'flights', 'hotels', 'accommodation'], color: '#A7B7CF' },
  { key: 'sidequests', name: 'Side quests', label: 'Side quests', examples: 'Hobbies, projects, things you want to try', aliases: ['side quest', 'side quests', 'hobby', 'hobbies', 'projects'], color: '#D0B3A5' },
  { key: 'fees', name: 'Fees & interest', label: 'Fees & interest', examples: 'Card interest, account fees, service charges', aliases: ['interest', 'bank fees', 'fees', 'service charges', 'finance charges'], color: '#C89988' },
  { key: 'cannabis', name: 'Goy', label: 'Goy', examples: 'Cannabis and vape retailers', aliases: ['cannabis & vape', 'cannabis', 'vape', 'vaping'], color: '#A5AE85' },
  { key: 'other', name: 'Other', label: 'Other', examples: 'Uncategorized expenses and one-off costs', aliases: ['uncategorized'], color: '#A4ACB9' },
];

export const normalizedCategory = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase('en-CA').replace(/\s+/g, ' ');
export const categoryTemplateFor = (limit: SpendingLimit) => expenseCategoryTemplates.find(template => limit.id === `${limit.entityId}:${template.key}`) ?? expenseCategoryTemplates.find(template => normalizedCategory(template.name) === normalizedCategory(limit.name));
export const isUncategorized = (category: string): boolean => !normalizedCategory(category) || normalizedCategory(category) === 'uncategorized';
const isOther = (limit: SpendingLimit) => normalizedCategory(limit.name) === 'other' || limit.id === `${limit.entityId}:other`;
const sampleBudgets: Record<string, readonly [number, number, number]> = { food: [3500, 18000, 70000], personal: [1000, 2500, 7500], digital: [1500, 5000, 12000], transport: [2500, 10000, 35000], other: [2000, 10000, 30000] };

export function categoryLimits(state: Pick<AppState, 'workspace' | 'spendingLimits'>, ownerId: string, includeDemoBudgets = false): SpendingLimit[] {
  const saved = (state.spendingLimits ?? []).filter(limit => limit.entityId === ownerId);
  const claimed = new Set(saved.flatMap(limit => [limit.name, ...limit.aliases]).map(normalizedCategory));
  const limits = saved.map(limit => ({ ...limit, aliases: [...limit.aliases] }));
  const personal = limits.find(limit => categoryTemplateFor(limit)?.key === 'personal');
  if (personal) {
    for (const alias of healthAliases) {
      const key = normalizedCategory(alias);
      if (claimed.has(key)) continue;
      personal.aliases.push(alias);
      claimed.add(key);
    }
  }
  for (const template of expenseCategoryTemplates) {
    if (saved.some(limit => limit.id === `${ownerId}:${template.key}` || normalizedCategory(limit.name) === normalizedCategory(template.name))) continue;
    let name = template.name;
    if (claimed.has(normalizedCategory(name))) {
      name = template.label;
      let suffix = 2;
      while (claimed.has(normalizedCategory(name))) name = `${template.label} ${suffix++}`;
    }
    const seen = new Set([normalizedCategory(name)]);
    const aliases = [...template.aliases, template.label].filter(alias => {
      const key = normalizedCategory(alias);
      if (claimed.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const sample = includeDemoBudgets && state.workspace === 'demo' ? sampleBudgets[template.key] : undefined;
    limits.push({ id: `${ownerId}:${template.key}`, entityId: ownerId, name, color: template.color, aliases, dailyCents: sample?.[0] ?? null, weeklyCents: sample?.[1] ?? null, monthlyCents: sample?.[2] ?? null });
    for (const alias of [name, ...aliases]) claimed.add(normalizedCategory(alias));
  }
  return limits.sort((a, b) => {
    const index = (limit: SpendingLimit) => {
      const template = categoryTemplateFor(limit);
      return template ? expenseCategoryTemplates.indexOf(template) : expenseCategoryTemplates.length - 1.5;
    };
    return index(a) - index(b) || a.name.localeCompare(b.name);
  });
}

export function categoryMatcher(limits: SpendingLimit[], savedIds: Set<string>): (category: string) => SpendingLimit {
  const fallback = limits.find(isOther)!;
  const byAlias = new Map<string, SpendingLimit>();
  for (const limit of [...limits].sort((a, b) => Number(savedIds.has(b.id)) - Number(savedIds.has(a.id)))) {
    if (limit === fallback) continue;
    for (const alias of [limit.name, ...limit.aliases]) {
      const key = normalizedCategory(alias);
      if (!byAlias.has(key)) byAlias.set(key, limit);
    }
  }
  return category => byAlias.get(normalizedCategory(category)) ?? fallback;
}

export function transactionCategoryMatcher(state: AppState, ownerId: string, limits: SpendingLimit[]): (transaction: Transaction) => SpendingLimit {
  const matchCategory = categoryMatcher(limits, new Set((state.spendingLimits ?? []).map(limit => limit.id)));
  const bySource = new Map<string, { limit: SpendingLimit; category: string }>();
  for (const obligation of state.obligations) {
    if (obligation.entityId !== ownerId || obligation.direction !== 'out') continue;
    const limit = obligationCategoryLimit(obligation, limits, matchCategory);
    if (limit) bySource.set(`Planned payment ${obligation.id}`, { limit, category: obligation.category });
  }
  return transaction => {
    if (transaction.expenseCategory !== undefined) return matchCategory(transaction.expenseCategory);
    const planned = bySource.get(transaction.plannedPayment ? `Planned payment ${transaction.plannedPayment.obligationId}` : transaction.source);
    const sameCategory = planned && (normalizedCategory(transaction.category) === normalizedCategory(planned.category) || isUncategorized(transaction.category) && isUncategorized(planned.category));
    return sameCategory ? planned.limit : matchCategory(transaction.category);
  };
}

function obligationCategoryLimit(obligation: Obligation, limits: SpendingLimit[], matchCategory: (category: string) => SpendingLimit): SpendingLimit {
  const category = matchCategory(obligation.category);
  const key = obligation.subscription ? 'subscriptions' : ['digital', 'other'].includes(categoryTemplateFor(category)?.key ?? '') ? 'bills' : null;
  return (key ? limits.find(limit => categoryTemplateFor(limit)?.key === key) : undefined) ?? category;
}

export function plannedExpenseCategory(state: Pick<AppState, 'spendingLimits'>, obligation: Obligation): string {
  const limits = categoryLimits({ ...state, workspace: 'live' }, obligation.entityId);
  const matchCategory = categoryMatcher(limits, new Set((state.spendingLimits ?? []).map(limit => limit.id)));
  return obligationCategoryLimit(obligation, limits, matchCategory).name;
}

export interface ExpenseCategorySuggestion { category: string; reason: string }

const merchantRules: { pattern: RegExp; category: string; reason: string }[] = [
  { pattern: /\b(?:RETAIL|CASH|PURCHASE) INTEREST\b|\b(?:MONTHLY|ACCOUNT|ANNUAL) FEE\b/, category: 'Fees & interest', reason: 'The statement describes interest or an account fee.' },
  { pattern: /\bCINEPLEX CINECLUB\b/, category: 'Subscriptions', reason: 'The description names the Cineclub membership.' },
  { pattern: /\bANTHROPIC\W+CLAUDE SUB\b/, category: 'Subscriptions', reason: 'The description explicitly identifies a Claude subscription.' },
  { pattern: /\bSPOTIFY\b/, category: 'Subscriptions', reason: 'The description names the Spotify streaming service.' },
  { pattern: /\bCINEPLEX\b/, category: 'Social', reason: 'The merchant is a cinema. Refunds use the same category as purchases.' },
  { pattern: /\b(?:CANNABIS|CANNA CABANA|VAPE)\b/, category: 'Goy', reason: 'The description identifies a cannabis or vape retailer.' },
  { pattern: /\b(?:SUPPLEMENTS|FITNESS CLUBS|GOODLIFE CLUBS|PADEL)\b/, category: 'Personal', reason: 'The description identifies fitness, padel, or supplements.' },
  { pattern: /\bPLATO'?S CLOSET\b/, category: 'Personal', reason: 'The merchant is a clothing resale store.' },
  { pattern: /\bSTEAM GAMES\b/, category: 'Digital', reason: 'The description identifies a digital game purchase.' },
  { pattern: /\bGOOGLE\s*\*\s*DESTINY RISING\b/, category: 'Digital', reason: 'The description names a game purchase billed through Google.' },
  { pattern: /\b(?:MOBIL(?=\s*@)|ESSO|PETRO-CANADA|PIONEER STN)\b/, category: 'Transport', reason: 'Gas-station merchant; fuel or shop purchase.' },
  { pattern: /\b(?:UBEREATS|UBER EATS|CAFE|CAFÉ|RESTAURANT|BURGER|PIZZA|CREAMERY|KUNG FU TEA|RABBA FINE FOODS?|PAK FOODS|CHICK-FIL-A|MCDONALD'?S|TIM HORTONS|POPEYES|TAZA XPRESS|TST-NAMKEEN|SHAWARMA|DONAIR|KABOB|KEBAB|BUBBLE TEA|SUPERMARKETS?)\b/, category: 'Food', reason: 'The description identifies food, a restaurant, a cafe, or groceries.' },
  { pattern: /\b(?:PITA (?:&|AND) HUMMUS|JABAL COFFEE|USMANIA GRILLS|YASEENS SHAWARMA?|I HEART BOBA|EGG CLUB|OSMOW'?S|LAZEEZ (?:L\d+|SHAWARMA))\b/, category: 'Food', reason: 'The description names a food or coffee merchant.' },
  { pattern: /\b(?:STARBUCKS|SBUX\s+\d+|SECOND CUP|BASKIN[ -]ROBBINS|DAVE'?S HOT CHICKEN|WENDY'?S|KFC(?:\/TB)?)\b/, category: 'Food', reason: 'The description names a restaurant, coffee, or ice-cream chain.' },
  { pattern: /\b(?:FRESHCO|LONGO'?S|NO FRILLS|RCSS\s*#\s*\d+)\b/, category: 'Food', reason: 'The description names a grocery store.' },
  { pattern: /\bUBERTRIP\b|\bUBER\s*\*\s*TRIP\b|\bPRESTO (?:FARE|MOBI|AUTO|APPL)\b|^PRESTO$/, category: 'Transport', reason: 'The description identifies an Uber trip or PRESTO transit payment.' },
  { pattern: /\b(?:TORONTO PARKING AUTHORITY|PARK(?:ING)? INDIGO)\b|\bIMPARK(?:\d+[A-Z]?\b|\s|$)/, category: 'Transport', reason: 'The description names a parking operator.' },
  { pattern: /\bAUTO SPA\b/, category: 'Transport', reason: 'The description identifies vehicle cleaning.' },
];

export function suggestExpenseCategory(description: string): ExpenseCategorySuggestion | null {
  const normalized = description.normalize('NFKC').toLocaleUpperCase('en-CA').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
  const rule = merchantRules.find(candidate => candidate.pattern.test(normalized));
  return rule ? { category: rule.category, reason: rule.reason } : null;
}

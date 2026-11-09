const pages = [
  { id: 'home', label: 'Home', icon: 'overview', description: 'Your cash, upcoming payments and recent spending.', sections: [] },
  { id: 'expenses', label: 'Expenses', icon: 'wallet', description: 'Monthly spending and regular payments.', sections: ['schedule', 'activity', 'plan'] },
  { id: 'pay', label: 'Work & pay', icon: 'coins', description: 'Pay statements, deposits and timecards.', sections: ['statements', 'hours', 'review'] },
  { id: 'debts', label: 'Debts', icon: 'activity', description: 'Balances, payment dates and repayment options.', sections: [] },
  { id: 'investments', label: 'Investments', icon: 'invest', description: 'Accounts, holdings and recorded returns.', sections: ['accounts'] },
  { id: 'assets', label: 'Assets', icon: 'devices', description: 'What you own, money owed to you and planned purchases.', sections: [] },
  { id: 'simulations', label: 'Planner', icon: 'plan', description: 'Plan your cash around paydays and payments.', sections: ['compare', 'setup', 'review'] },
  { id: 'documents', label: 'Statements', icon: 'clock', description: 'Bank statements, import review and original files.', sections: ['imports', 'files'] },
] as const;

export type View = typeof pages[number]['id'];
export type Section = typeof pages[number]['sections'][number];
export interface Route { view: View; section?: Section }

export const navigation: [View, string][] = pages.map(page => [page.id, page.label]);
export const navigationGroups: { label: string; views: View[] }[] = [
  { label: 'Day to day', views: ['home', 'expenses', 'simulations'] },
  { label: 'Your money', views: ['debts', 'investments', 'assets'] },
  { label: 'Records', views: ['documents', 'pay'] },
];
export function pageDetails(view: View) { return pages.find(page => page.id === view)!; }

export function parseRoute(hash: string): Route | null {
  const [view, section, ...rest] = hash.replace(/^#/, '').split('?')[0].split('/');
  if (!view) return rest.length || section ? null : { view: 'home' };
  const page = pages.find(page => page.id === view);
  if (rest.length || !page) return null;
  if (!section) return { view: page.id };
  if (!(page.sections as readonly string[]).includes(section)) return null;
  return { view: page.id, section: section as Section };
}

export function routeHash(view: View, section?: Section, recordId?: string): string {
  if (view === 'simulations' && recordId?.startsWith('setup:')) section = 'setup';
  return `#${view}${section ? `/${section}` : ''}${recordId ? `?record=${encodeURIComponent(recordId)}` : ''}`;
}

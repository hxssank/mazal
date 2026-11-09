import {useState} from 'react';
import {AccountEditor} from '../../components/RecordActions.tsx';
import type { Account, Command, AccountType, AppState } from '../../../shared/types';
import { money } from '../../../shared/analytics';
import Icon from '../../components/Icon';

interface Props {
  state: AppState;
  readOnly: boolean;
  onCommand:(command:Command)=>Promise<void>;
  onAddAccount: (accountType?: AccountType) => void;
  onOpen: (kind: 'reconcile', accountId: string) => void;
}

const checkedDate = (value: string) => new Date(`${value.slice(0, 10)}T12:00:00`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });

export default function InvestmentAccounts({ state, readOnly, onAddAccount, onOpen, onCommand }: Props) {
  const [editing,setEditing]=useState<Account|null>(null);
  const entityId = state.entities.find(entity => entity.kind === 'personal')?.id;
  const accounts = state.accounts.filter(account => ['cash', 'receivable'].includes(account.type) && account.entityId === entityId);
  const cash = accounts.filter(account => account.type === 'cash');
  const receivables = accounts.filter(account => account.type === 'receivable');
  const addCash = () => onAddAccount('cash');

  return <div className="investment-accounts">
    {editing&&!readOnly&&<AccountEditor account={editing} state={state} onCommand={onCommand} onClose={()=>setEditing(null)}/>}
    {accounts.length === 0 ? <div className="panel investment-accounts-empty"><span className="investment-account-icon"><Icon name="wallet" size={24}/></span><div><h2>No cash account added</h2><p>Add your bank balance or cash on hand.</p>{!readOnly && <button type="button" className="button primary" onClick={addCash}><Icon name="plus" size={16}/>Add cash account</button>}</div></div> : <div className="investment-account-groups">{([{ kind: 'cash', title: 'Cash & bank', subtitle: '', items: cash }, { kind: 'receivable', title: 'Money owed to you', subtitle: 'Not cash until received', items: receivables }] as const).filter(group => group.kind === 'cash' || group.items.length).map(group => <div className={`panel investment-account-group investment-account-${group.kind}`} key={group.kind}>
      <div className="investment-account-group-heading"><span className="investment-account-icon"><Icon name={group.kind === 'cash' ? 'wallet' : 'down'} size={20}/></span><div><h2>{group.title}</h2>{group.subtitle && <p>{group.subtitle}</p>}</div></div>
      {group.items.length ? group.items.map(account => <div className="portfolio-account-row" key={account.id}><div><h3>{account.name}{account.closedAt?' · Closed':''}</h3>{!readOnly&&<button type="button" className="text-button" onClick={()=>setEditing(account)}>Manage account</button>}<small className={account.reconciledAt ? '' : 'investment-account-unchecked'}>{account.reconciledAt ? `Checked ${checkedDate(account.reconciledAt)}` : 'Balance not checked'}</small></div><strong>{money(account.balanceCents)}</strong>{!readOnly && !account.closedAt && <button type="button" className="button secondary compact" onClick={() => onOpen('reconcile', account.id)}>Update balance</button>}</div>) : <div className="investment-missing-cash"><p>No cash balance recorded.</p>{!readOnly && <button type="button" className="button secondary" onClick={addCash}><Icon name="plus" size={16}/>Add cash account</button>}</div>}
    </div>)}</div>}
  </div>;
}

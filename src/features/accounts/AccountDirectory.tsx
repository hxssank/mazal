import {useEffect,useId,useRef,useState} from 'react';
import type {Account,AppState,Command} from '../../../shared/types.ts';
import {money} from '../../../shared/analytics.ts';
import {AccountEditor} from '../../components/RecordActions.tsx';
import '../expenses/expense-bills.css';
export default function AccountDirectory({state,onCommand,onClose}:{state:AppState;onCommand:(command:Command)=>Promise<void>;onClose:()=>void}){
  const [editing,setEditing]=useState<Account|null>(null);const dialog=useRef<HTMLDialogElement>(null),returnAccount=useRef(''),id=useId();
  useEffect(()=>{const element=dialog.current;if(!editing){element?.showModal();if(returnAccount.current){const target=[...(element?.querySelectorAll<HTMLButtonElement>('[data-account-id]')??[])].find(button=>button.dataset.accountId===returnAccount.current);(target??element?.querySelector<HTMLButtonElement>('[aria-label="Close accounts"]'))?.focus();}}return()=>element?.close();},[editing]);
  if(editing)return <AccountEditor state={state} account={editing} onCommand={onCommand} onClose={()=>setEditing(null)}/>;
  return <dialog ref={dialog} className="bill-dialog account-directory" aria-labelledby={id} onCancel={event=>{event.preventDefault();onClose();}}><header className="bill-dialog-heading"><h2 id={id}>Manage accounts</h2><button className="bill-close" aria-label="Close accounts" onClick={onClose}>×</button></header><div className="bill-fields"><p>Rename or close an account while retaining its history.</p>{state.accounts.map(account=><div className="account-directory-row" key={account.id}><div className="account-directory-copy"><h3>{account.name}</h3><p>{state.entities.find(item=>item.id===account.entityId)?.name} · {account.type} · {account.closedAt?`Closed ${account.closedAt}`:'Open'}</p></div><strong>{money(account.balanceCents)}</strong><button className="bill-button bill-secondary" data-account-id={account.id} aria-label={`Manage ${account.name}`} onClick={()=>{returnAccount.current=account.id;setEditing(account);}}>Manage</button></div>)}</div><footer className="bill-dialog-footer"><button className="bill-button bill-secondary" onClick={onClose}>Done</button></footer></dialog>;
}

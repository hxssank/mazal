import { lazy } from 'react';
import type { AccountType, AppState, Command } from '../../shared/types.ts';
import type { FormKind, FormSelection } from './form-selection.ts';
import type { Section, View } from './routes.ts';
import Home from '../features/home/Home.tsx';

const Investments = lazy(() => import('../features/investments/Investments.tsx'));
const Expenses = lazy(() => import('../features/expenses/Expenses.tsx'));
const WorkPay = lazy(() => import('../features/pay/WorkPay.tsx'));
const Debts = lazy(() => import('../features/debts/Debts.tsx'));
const Planner = lazy(() => import('../features/planner/Planner.tsx'));
const Assets = lazy(() => import('../features/assets/Assets.tsx'));
const DocumentLibrary = lazy(() => import('../features/records/DocumentLibrary.tsx'));

interface Props {
  state: AppState;
  scope: string;
  view: View;
  section?: Section;
  routeRecord: string;
  readOnly: boolean;
  motion: boolean;
  personal: boolean;
  command: (command: Command) => Promise<void>;
  navigate: (view: View, section?: Section, recordId?: string) => void;
  open: (kind: FormKind, accountId?: string, positionId?: string) => void;
  openForm: (selection: FormSelection) => void;
  addInvestmentAccount: (accountType?: AccountType) => void;
}

export default function WorkspaceView({ state, scope, view, section, routeRecord, readOnly, motion, personal, command, navigate, open, openForm, addInvestmentAccount }: Props) {
  const workspace = state.workspace;
  return <>
        {view==='home'&&<Home key={`${workspace}-${scope}`} state={state} scope={scope} readOnly={readOnly} motion={motion} onCommand={command} onNavigate={navigate} onOpen={open} onBackups={personal?()=>open('backup'):undefined}/>}
        {view==='investments'&&<Investments key={`${workspace}-${scope}`} initialSection={section==='accounts'?'accounts':undefined} onSectionChange={next=>navigate('investments',next)} state={state} readOnly={readOnly} onOpen={open} onAddAccount={addInvestmentAccount} onCommand={command}/>}
        {view==='expenses'&&<Expenses key={`${workspace}-${scope}`} initialSection={section==='schedule'||section==='activity'||section==='plan'?section:undefined} onSectionChange={next=>navigate('expenses',next,next&&state.expensePlanItems?.some(item=>item.id===routeRecord&&item.entityId===scope)?routeRecord:undefined)} state={state} scope={scope} readOnly={readOnly} onCommand={command} onOpen={open}/>}
        {view==='pay'&&<WorkPay initialSection={section==='statements'?'pay':section==='hours'||section==='review'?section:undefined} onSectionChange={next=>navigate('pay',next==='pay'?'statements':next)} state={state} onCommand={readOnly?undefined:command}/>}
        {view==='debts'&&<Debts key={`${workspace}-${scope}`} state={state} scope={scope} readOnly={readOnly} onCommand={command} onOpen={open}/>}
        {view==='simulations'&&<Planner key={`${workspace}-${scope}`} initialSection={section==='compare'||section==='setup'||section==='review'?section:undefined} onSectionChange={next=>navigate('simulations',next)} state={state} scope={scope} readOnly={readOnly} motion={motion} onCommand={command} onNavigate={navigate} onOpen={open} onRecord={(kind,accountId)=>openForm({kind:'transaction',initialTransactionKind:kind,...(kind==='debt_payment'?{initialToAccountId:accountId}:{accountId})})}/>}
        {view==='assets'&&<Assets key={`${workspace}-${scope}`} state={state} readOnly={readOnly} onCommand={command} onOpen={open}/>}
        {view==='documents'&&<DocumentLibrary initialSection={section==='imports'||section==='files'?section:undefined} onSectionChange={next=>navigate('documents',next)} state={state} scope={scope} readOnly={readOnly} onCommand={command} onTransactions={()=>navigate('expenses','activity')} onImportStatement={()=>open('import')}/>}
  </>;
}

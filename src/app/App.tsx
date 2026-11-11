import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AccountType, Workspace } from '../../shared/types.ts';
import { requestDraftNavigation } from '../hooks/draft-protection.ts';
import { createGuardedHistory } from './guarded-history.ts';
import Icon from '../components/Icon.tsx';
import MazalMark from '../components/MazalMark.tsx';
import { useWorkspaceRecords } from './useWorkspaceRecords.ts';
import { navigation, navigationGroups, pageDetails, parseRoute, routeHash, type Section, type View } from './routes.ts';
import type { FormKind, FormSelection } from './form-selection.ts';
import '../features/entries/forms.css';
import WorkspaceView from './WorkspaceView.tsx';
import '../features/records/document-library.css';
import useGlassAppearance from '../hooks/useGlassAppearance.ts';
import useLiquidNavigation from '../hooks/useLiquidNavigation.ts';
import useGlassClicks from '../hooks/useGlassClicks.ts';
import useHomeMotion from '../hooks/useHomeMotion.ts';
import useLiveMotion from '../hooks/useLiveMotion.ts';
import RecordFreshness from '../components/RecordFreshness.tsx';
import ErrorBoundary from '../components/ErrorBoundary.tsx';
import CommandPalette, { type CommandAction } from './CommandPalette.tsx';
import './styles/workspace-design.css';
import './styles/daily-workspace.css';
import './styles/navigation-menu.css';
import './styles/organized-ui.css';
import './styles/top-navigation.css';
import './styles/live-workspace.css';

const AccountDirectory=lazy(()=>import('../features/accounts/AccountDirectory.tsx'));
const Forms = lazy(() => import('../features/entries/Forms.tsx'));

export default function App() {
  const shellRef=useRef<HTMLDivElement>(null);
  const appearance=useGlassAppearance(shellRef);
  const workspace:Workspace='live';
  const routeHistory=useRef<ReturnType<typeof createGuardedHistory>|null>(null);
  const [routeRecord,setRouteRecord]=useState(()=>new URLSearchParams(window.location.hash.split('?')[1]).get('record')??'');
  const [view,setView]=useState<View>(()=>parseRoute(window.location.hash)?.view??'home');
  const [section,setSection]=useState<Section|undefined>(()=>parseRoute(window.location.hash)?.section);
  const [manageAccounts,setManageAccounts]=useState(false);
  const [moreOpen,setMoreOpen]=useState(false);
  const [searchOpen,setSearchOpen]=useState(false);
  const searchRef=useRef<HTMLButtonElement>(null);
  const [navigationFocus,setNavigationFocus]=useState(0);
  const [form,setForm]=useState<FormSelection|null>(null);
  const navRef=useRef<HTMLElement>(null);
  const addRef=useRef<HTMLDetailsElement>(null);
  const utilityRef=useRef<HTMLDivElement>(null);
  const moreRef=useRef<HTMLButtonElement>(null);
  const acceptedRoute=useRef({view,record:routeRecord});
  const recordRef=useRef<HTMLButtonElement>(null);
  const formRef=useRef<FormSelection|null>(null);
  const activationTrigger=useRef<HTMLElement|null>(null);
  const formTrigger=useRef<HTMLElement|null>(null);
  const pendingFormFocus=useRef<{trigger:HTMLElement|null}|null>(null);
  const accountsTrigger=useRef<HTMLElement|null>(null);
  const pageHeading=useRef<HTMLHeadingElement>(null);
  const { state, dataSource, readOnly, error, notice, refreshing, lastChecked, refresh, command, setError, setNotice } = useWorkspaceRecords(workspace, {
    onResetForms: () => { pendingFormFocus.current = null; formRef.current = null; setForm(null); },
  });
  const scope=state?.entities.find(entity=>entity.kind==='personal')?.id??'personal';
  useLiquidNavigation(navRef,view,appearance.motion);
  useGlassClicks(shellRef,appearance.motion);
  useHomeMotion(shellRef, view==='home'&&appearance.motion, view==='home'&&!!state);
  useLiveMotion(shellRef, appearance.motion, `${view}-${section??''}-${routeRecord}`);

  useEffect(()=>{
    const navigation=createGuardedHistory({window,requestNavigation:requestDraftNavigation,onNavigate:hash=>{
      const route=parseRoute(hash);if(!route)return;
      if(addRef.current)addRef.current.open=false;
      setMoreOpen(false);
      const record=new URLSearchParams(hash.split('?')[1]).get('record')??'';
      const movedPage=acceptedRoute.current.view!==route.view||acceptedRoute.current.record!==record;
      acceptedRoute.current={view:route.view,record};
      setView(route.view);setSection(route.section);setRouteRecord(record);
      pendingFormFocus.current=null;setForm(null);formRef.current=null;setManageAccounts(false);
      if(movedPage){setNavigationFocus(value=>value+1);window.scrollTo(0,0);}
    }});
    routeHistory.current=navigation;
    return()=>{navigation.dispose();routeHistory.current=null;};
  },[]);
  useLayoutEffect(()=>{
    if(!navigationFocus||routeRecord)return;
    if(!document.querySelector('dialog[open]'))pageHeading.current?.focus({preventScroll:true});
  },[navigationFocus,routeRecord]);
  useLayoutEffect(()=>{
    if(form||!pendingFormFocus.current)return;
    const {trigger}=pendingFormFocus.current;
    pendingFormFocus.current=null;
    if(!formRef.current&&!document.querySelector('dialog[open]')){
      (trigger?.isConnected?trigger:pageHeading.current)?.focus({preventScroll:true});
    }
  },[form]);
  useEffect(()=>{
    const outside=(event:PointerEvent|FocusEvent)=>{
      const target=event.target as Node;
      if(event.type==='pointerdown'&&addRef.current&&!addRef.current.contains(target))addRef.current.open=false;
      if(!utilityRef.current?.contains(target)&&!moreRef.current?.contains(target))setMoreOpen(false);
    };
    const escape=(event:KeyboardEvent)=>{
      if(event.key!=='Escape')return;
      if(addRef.current?.open){addRef.current.open=false;addRef.current.querySelector('summary')?.focus();}
      if(moreOpen){setMoreOpen(false);moreRef.current?.focus();}
    };
    document.addEventListener('pointerdown',outside);document.addEventListener('focusin',outside);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('focusin',outside);document.removeEventListener('keydown',escape);};
  },[moreOpen]);
  useEffect(()=>{navRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({block:'nearest',inline:'nearest'});document.title=`${navigation.find(([id])=>id===view)?.[1]} · Mazal${dataSource==='personal'?'':' preview'}`;},[view,dataSource]);
  useEffect(()=>{
    const search=(event:KeyboardEvent)=>{
      if(event.key.toLowerCase()!=='k'||!(event.metaKey||event.ctrlKey)||event.altKey||event.isComposing)return;
      if(document.querySelector('dialog[open]'))return;
      event.preventDefault();
      if(addRef.current)addRef.current.open=false;
      setMoreOpen(false);setSearchOpen(true);
    };
    window.addEventListener('keydown',search);
    return()=>window.removeEventListener('keydown',search);
  },[]);
  function navigate(next:View,nextSection?:Section,recordId?:string){
    routeHistory.current?.navigate(routeHash(next,nextSection,recordId));
  }
  function openForm(selection: FormSelection) {
    if(readOnly){setNotice('This preview is read-only. Open Mazal.app to change your records.');return;}
    const trigger=returnFocusTarget();
    requestDraftNavigation(()=>{
    pendingFormFocus.current = null;
    formTrigger.current = trigger;
    if (addRef.current) addRef.current.open = false;
    setMoreOpen(false);
    formRef.current = selection;
    setForm(selection);
    });
  }
  function returnFocusTarget() {
    const active=document.activeElement;
    const trigger=activationTrigger.current??(active instanceof HTMLElement&&active!==document.body?active:recordRef.current);
    if(trigger&&utilityRef.current?.contains(trigger))return moreRef.current;
    return trigger?.closest('.toolbar-add details')?.querySelector<HTMLElement>('summary')??trigger;
  }
  function openAccounts() {
    const trigger=returnFocusTarget();
    requestDraftNavigation(()=>{
      accountsTrigger.current=trigger;
      if(addRef.current)addRef.current.open=false;
      setMoreOpen(false);
      setManageAccounts(true);
    });
  }
  function closeAccounts() {
    setManageAccounts(false);
    window.requestAnimationFrame(()=>{if(accountsTrigger.current?.isConnected)accountsTrigger.current.focus();});
  }
  function closeForm(selection: FormSelection) {
    if (formRef.current !== selection) return;
    pendingFormFocus.current = { trigger: formTrigger.current };
    formRef.current = null;
    setForm(null);
  }
  function open(kind:FormKind,accountId?:string,positionId?:string){
    const debtDestination=kind==='transaction'&&view==='debts'?state?.accounts.find(account=>account.id===accountId&&(account.type==='debt'||account.type==='payable')):undefined;
    openForm({kind,accountId:debtDestination?undefined:accountId,positionId,initialToAccountId:debtDestination?.id,...(kind==='account'?{initialAccountType:view==='investments'?'investment':view==='debts'?'debt':'cash'}:{}),...(kind==='transaction'?{initialTransactionKind:view==='debts'?'debt_payment' as const:'expense' as const}:{})});
  }
  function addInvestmentAccount(initialAccountType:AccountType='investment'){openForm({kind:'account',initialAccountType});}
  function addTransaction(initialTransactionKind:FormSelection['initialTransactionKind']){openForm({kind:'transaction',initialTransactionKind});}
  const restoreOpened=useRef(false);
  useEffect(()=>{if(state&&!readOnly&&!restoreOpened.current&&new URLSearchParams(window.location.search).get('setup')==='restore'){restoreOpened.current=true;const selection:FormSelection={kind:'backup'};formRef.current=selection;setForm(selection);}},[state,readOnly]);
  const title=navigation.find(item=>item[0]===view)![1];
  const searchActions:CommandAction[]=[
    ...navigation.map(([id,label])=>({id,label,description:pageDetails(id).description,icon:pageDetails(id).icon,group:'Go to' as const,keywords:id==='simulations'?'forecast cash flow schedule':id==='expenses'?'bills subscriptions spending transactions':id==='documents'?'imports files bank records':id==='pay'?'salary payroll income timecards':'',run:()=>navigate(id)})),
    {id:'activity',label:'Transaction history',description:'Find and review recorded transactions.',icon:'activity',group:'Go to',keywords:'ledger expense income transfer',run:()=>navigate('expenses','activity')},
    {id:'payments',label:'Bills and payments',description:'Review payment dates and recurring bills.',icon:'repeat',group:'Go to',keywords:'schedule subscriptions rent',run:()=>navigate('expenses','schedule')},
    ...(state&&!readOnly?[
      {id:'expense',label:'Record an expense',description:'Add a purchase or everyday spending.',icon:'plus',group:'Actions' as const,keywords:'add transaction spending',run:()=>addTransaction('expense')},
      {id:'income',label:'Record income',description:'Add money received into an account.',icon:'coins',group:'Actions' as const,keywords:'add transaction deposit pay',run:()=>addTransaction('income')},
      {id:'transfer',label:'Record a transfer',description:'Record money moved between your accounts.',icon:'arrow',group:'Actions' as const,keywords:'add transaction move',run:()=>addTransaction('transfer')},
      {id:'bill',label:'Add a bill',description:'Plan a bill or expected income.',icon:'clock',group:'Actions' as const,keywords:'obligation recurring payment',run:()=>open('obligation')},
      {id:'accounts',label:'Manage accounts',description:'Review accounts and their saved balances.',icon:'wallet',group:'Actions' as const,keywords:'bank cash reconciliation',run:openAccounts},
      {id:'backup',label:'Backups and data',description:'Manage backups and restore saved records.',icon:'shield',group:'Actions' as const,keywords:'settings export',run:()=>open('backup')},
    ]:[]),
  ];
  function closeSearch(){setSearchOpen(false);window.requestAnimationFrame(()=>searchRef.current?.focus());}
  function selectSearchAction(action:CommandAction){
    setSearchOpen(false);
    activationTrigger.current=searchRef.current;
    action.run();
    activationTrigger.current=null;
    window.requestAnimationFrame(()=>{
      if(!formRef.current&&!document.querySelector('dialog[open]')&&document.activeElement===document.body)pageHeading.current?.focus({preventScroll:true});
    });
  }

  return <div ref={shellRef} className="app-shell workspace-theme daily-workspace organized-workspace" data-motion={appearance.motion?'on':'off'} data-palette="dark" onClickCapture={event=>{const trigger=(event.target as Element).closest<HTMLElement>('button, summary, a[href]');activationTrigger.current=trigger;window.setTimeout(()=>{if(activationTrigger.current===trigger)activationTrigger.current=null;},0);}}>
    <a className="skip-link" href="#content" onClick={event=>{event.preventDefault();document.getElementById('content')?.focus();}}>Skip to content</a>
    <header className="workspace-header">
      <div className="glass-toolbar workspace-masthead">
        <div className="workspace-brand"><button className="brand" onClick={()=>navigate('home')} aria-label="Mazal home"><MazalMark/><span>mazal</span></button><span className="workspace-tagline">Personal finance</span></div>
      <div className="toolbar-actions">
      <button ref={searchRef} type="button" className="workspace-search" aria-label="Search pages and actions" aria-keyshortcuts="Meta+K Control+K" onClick={()=>{if(addRef.current)addRef.current.open=false;setMoreOpen(false);setSearchOpen(true);}}><Icon name="search" size={16}/><span>Search &amp; actions</span><kbd aria-hidden="true">{navigator.platform.includes('Mac')?'⌘':'Ctrl'} K</kbd></button>
      <div className="toolbar-add">
        <button ref={recordRef} className="toolbar-record" aria-label="Add transaction" disabled={!state||readOnly} onClick={()=>addTransaction('expense')}><Icon name="plus" size={16}/><span>Add transaction</span></button>
        <details className="quick-add" ref={addRef} onBlur={event=>{if(event.relatedTarget&&!event.currentTarget.contains(event.relatedTarget as Node))event.currentTarget.open=false;}}>
          <summary className="toolbar-add-toggle" aria-label="More add options"><Icon name="down" size={16}/></summary>
          <div className="quick-add-panel">
            <p className="navigation-menu-label">Transactions</p>
            <button disabled={!state||readOnly} onClick={()=>addTransaction('expense')}><Icon name="wallet" size={18}/><span>Expense</span></button>
            <button disabled={!state||readOnly} onClick={()=>addTransaction('income')}><Icon name="down" size={18}/><span>Income</span></button>
            <button disabled={!state||readOnly} onClick={()=>addTransaction('debt_payment')}><Icon name="debt" size={18}/><span>Debt payment</span></button>
            <button disabled={!state||readOnly} onClick={()=>addTransaction('transfer')}><Icon name="arrow" size={18}/><span>Transfer</span></button>
            <div className="navigation-menu-divider"/>
            <p className="navigation-menu-label">Planning and accounts</p>
            <button disabled={!state||readOnly} onClick={()=>open('obligation')}><Icon name="clock" size={18}/><span>Bill or expected income</span></button>
            <button disabled={!state||readOnly} onClick={()=>openForm({kind:'account',initialAccountType:'cash'})}><Icon name="plus" size={18}/><span>Cash or bank account</span></button>
            <button disabled={!state||readOnly} onClick={()=>open('reserve')}><Icon name="wallet" size={18}/><span>Set money aside</span></button>
            <button disabled={!state||readOnly} onClick={()=>navigate('documents')}><Icon name="clock" size={18}/><span>Review records</span></button>
          </div>
        </details>
      </div>
      <div className="workspace-settings">
      <button ref={moreRef} type="button" className="navigation-more-toggle workspace-settings-toggle" aria-label="Settings and data" aria-expanded={moreOpen} aria-controls="more-navigation" onClick={()=>{if(addRef.current)addRef.current.open=false;setMoreOpen(value=>!value);}}><Icon name="settings" size={18}/><span>Settings &amp; data</span><Icon name="down" size={14}/></button>
      {moreOpen&&<div ref={utilityRef} id="more-navigation" className="workspace-utilities quick-add-panel navigation-more-panel" role="group" aria-label="Settings and data">
        <p className="navigation-menu-label">Manage</p>
        <button disabled={!state||readOnly} onClick={openAccounts}><Icon name="wallet" size={18}/><span>Manage accounts</span></button>
        <button disabled={!state||readOnly} onClick={()=>open('backup')}><Icon name="clock" size={18}/><span>Backups and data</span></button>
        <div className="navigation-menu-divider"/>
        <div className="record-sync" title={dataSource==='snapshot'?'This preview uses a fixed copy of your saved records.':'Checks local records every 15 seconds while this window is visible. Bank data updates when you record or import it.'} data-status={error?'error':refreshing?'checking':'ready'}><i className="record-status-dot" aria-hidden="true"/><span>{error?(state?'Refresh needed':'Records unavailable'):lastChecked?`Records checked ${lastChecked.toLocaleTimeString('en-CA',{hour:'numeric',minute:'2-digit',second:'2-digit'})}`:'Reading saved records'}</span></div>
        <button type="button" disabled={refreshing} onClick={()=>void refresh()} aria-label="Refresh saved records"><Icon name="arrow" size={18}/><span>{refreshing?'Refreshing…':'Refresh records'}</span></button>
        <button type="button" className="motion-toggle" onClick={appearance.toggleMotion} disabled={appearance.reducedMotion} aria-pressed={appearance.motion} aria-label={appearance.reducedMotion?'Animation off: Reduce Motion is enabled in system settings':appearance.motion?'Pause animations':'Resume animations'} title={appearance.reducedMotion?'Reduce Motion is enabled in system settings':appearance.motion?'Pause animations':'Resume animations'}><span className="motion-indicator" aria-hidden="true"><i/><i/><i/></span><span>{appearance.motion?'Motion on':'Motion off'}</span></button>
      </div>}
      </div>
      </div>
      </div>
      <nav ref={navRef} className="top-navigation" aria-label="Main navigation">
        <span className="nav-glass-indicator" aria-hidden="true"/>
        {navigationGroups.map(group=><div key={group.label} className="top-nav-group" role="group" aria-label={group.label}>{group.views.map(id=>{const active=view===id;const label=navigation.find(item=>item[0]===id)![1];return <button key={id} className={`top-nav-item ${active?'active':''}`} onClick={()=>navigate(id)} aria-current={active?'page':undefined}><Icon name={pageDetails(id).icon} size={18}/><span>{label}</span></button>;})}</div>)}
      </nav>
    </header>
    <main id="content" className="main" tabIndex={-1}><div className="page-content">
      {dataSource!=='personal'&&<aside className="sample-preview-notice" aria-label={dataSource==='sample'?'Sample data preview':'Read-only records preview'}><Icon name="info" size={21}/><div><strong>{dataSource==='sample'?'Design preview · Sample data':'Read-only preview of your records'}</strong><p>{dataSource==='sample'?'These balances and transactions are examples, not your financial records. Open Mazal.app for your records.':'Uses a copy of your saved records. Restart the preview to load newer changes.'}</p></div></aside>}
      {error&&<div className="error-banner" role="alert">{error}<button className="button secondary" disabled={refreshing} onClick={()=>void refresh()}>{refreshing?'Retrying…':'Retry'}</button>{state&&<button className="icon-button" aria-label="Dismiss error" onClick={()=>setError('')}><Icon name="close"/></button>}</div>}
      {!state?<div className="loading-panel" role={error?undefined:'status'}><h1>{error?'Unable to open records':'Opening Mazal'}</h1></div>:<>
        <RecordFreshness source={dataSource} checked={lastChecked} refreshing={refreshing} error={!!error} onRefresh={()=>void refresh()}/>
        {view==='home'?<h1 ref={pageHeading} tabIndex={-1} className="sr-only">Home</h1>:<div className="page-heading"><div className="page-title"><h1 ref={pageHeading} tabIndex={-1}>{title}</h1><p className="page-description">{pageDetails(view).description}</p></div><span className="page-currency" aria-label="Amounts in Canadian dollars">CAD</span></div>}
        <div className="page-body" key={`${workspace}-${view}-${routeRecord}`}><ErrorBoundary><Suspense fallback={<div className="loading-panel" role="status">Opening {title.toLowerCase()}…</div>}>
        <WorkspaceView state={state} scope={scope} view={view} section={section} routeRecord={routeRecord} readOnly={readOnly} motion={appearance.motion} personal={dataSource==='personal'} command={command} navigate={navigate} open={open} openForm={openForm} addInvestmentAccount={addInvestmentAccount}/>
        </Suspense></ErrorBoundary></div>
      </>}
    </div></main>
    {searchOpen&&<CommandPalette actions={searchActions} onSelect={selectSearchAction} onClose={closeSearch}/>}
    {state&&manageAccounts&&!readOnly&&<ErrorBoundary onClose={closeAccounts}><Suspense fallback={<div className="toast" role="status">Opening accounts…</div>}><AccountDirectory state={state} onCommand={command} onClose={closeAccounts}/></Suspense></ErrorBoundary>}
    {state&&form&&<ErrorBoundary key={`${workspace}-${form.kind}-${form.accountId??''}-${form.initialToAccountId??''}`} onClose={()=>closeForm(form)}><Suspense fallback={<div className="toast" role="status">Opening form…</div>}><Forms {...form} state={state} onCommand={command} onClose={()=>closeForm(form)}/></Suspense></ErrorBoundary>}
    {notice&&<div className="toast" role="status"><Icon name="check" size={17}/>{notice}<button className="icon-button" onClick={()=>setNotice('')} aria-label="Dismiss notification"><Icon name="close" size={14}/></button></div>}
  </div>;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createGuardedHistory } from './app/guarded-history.ts';

const require=createRequire(import.meta.url);
const {JSDOM}=require('jsdom');
async function until(check:()=>boolean) {
  for(let count=0;count<100;count++){if(check())return;await new Promise(resolve=>setTimeout(resolve,2));}
  assert.ok(check(),'History did not reach the expected entry.');
}
function fixture(t:{after:(callback:()=>void)=>void}) {
  const dom=new JSDOM('',{url:'http://localhost/#home'});
  const window=dom.window as Window;
  let dirty=false;
  let continuation:(()=>void)|null=null;
  const rendered:string[]=[];
  const route=createGuardedHistory({window,onNavigate:hash=>rendered.push(hash),requestNavigation:proceed=>{if(dirty){continuation=proceed;return false;}proceed();return true;}});
  t.after(()=>{route.dispose();dom.window.close();});
  return {window,route,rendered,setDirty:(value:boolean)=>{dirty=value;},discard:()=>{dirty=false;const next=continuation;continuation=null;next?.();},keep:()=>{continuation=null;},pending:()=>!!continuation};
}

test('cancelled Back preserves both earlier entries and a later accepted Back/Forward traversal',async t=>{
  const f=fixture(t);
  f.route.navigate('#expenses/activity?record=entry%201');f.route.navigate('#assets');
  const length=f.window.history.length;
  f.setDirty(true);f.window.history.back();
  await until(()=>f.pending()&&f.window.location.hash==='#assets');
  assert.equal(f.rendered.at(-1),'#assets');assert.equal(f.window.history.length,length);
  f.keep();f.setDirty(false);f.window.history.back();
  await until(()=>f.rendered.at(-1)==='#expenses/activity?record=entry%201');
  f.window.history.back();await until(()=>f.rendered.at(-1)==='#home');
  f.window.history.forward();await until(()=>f.rendered.at(-1)==='#expenses/activity?record=entry%201');
  f.window.history.forward();await until(()=>f.rendered.at(-1)==='#assets');
  assert.equal(f.window.history.length,length);
});

test('discard after a blocked Back returns to its original entry without creating another history item',async t=>{
  const f=fixture(t);
  f.route.navigate('#documents/imports?record=batch');f.route.navigate('#simulations?record=payday%3A2026-10-02');
  f.setDirty(true);f.window.history.back();
  await until(()=>f.pending()&&f.window.location.hash.startsWith('#simulations'));
  f.discard();await until(()=>f.rendered.at(-1)==='#documents/imports?record=batch');
  assert.equal(f.window.history.length,3);
  f.window.history.forward();await until(()=>f.rendered.at(-1)==='#simulations?record=payday%3A2026-10-02');
});

test('blocked direct hash changes retain drafts and remain reachable through Forward after keeping edits',async t=>{
  const f=fixture(t);f.route.navigate('#expenses');f.setDirty(true);
  f.window.location.hash='#documents/imports';
  await until(()=>f.pending()&&f.window.location.hash==='#expenses');
  assert.equal(f.rendered.at(-1),'#expenses');f.keep();f.setDirty(false);
  f.window.history.forward();await until(()=>f.rendered.at(-1)==='#documents/imports');
  f.window.history.back();await until(()=>f.rendered.at(-1)==='#expenses');
});

test('programmatic navigation waits for discard and truncates only the abandoned forward branch',async t=>{
  const f=fixture(t);f.route.navigate('#expenses');f.route.navigate('#assets');
  f.window.history.back();await until(()=>f.rendered.at(-1)==='#expenses');
  f.setDirty(true);f.route.navigate('#documents/imports?record=review');
  assert.equal(f.window.location.hash,'#expenses');assert.equal(f.window.history.length,3);
  f.discard();assert.equal(f.window.location.hash,'#documents/imports?record=review');assert.equal(f.window.history.length,3);
  f.window.history.back();await until(()=>f.rendered.at(-1)==='#expenses');
  f.window.history.back();await until(()=>f.rendered.at(-1)==='#home');
});

test('a draft stays on its accepted page when Back is pressed again during restoration',async t=>{
  const f=fixture(t);f.route.navigate('#expenses');f.route.navigate('#assets');f.route.navigate('#documents');f.setDirty(true);
  let repeated=false;
  f.window.addEventListener('popstate',()=>{if(!repeated&&f.window.location.hash==='#assets'){repeated=true;f.window.history.back();}});
  f.window.history.back();
  await until(()=>repeated&&f.pending()&&f.window.location.hash==='#documents');
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(f.window.location.hash,'#documents');assert.equal(f.rendered.at(-1),'#documents');
  f.discard();await until(()=>f.rendered.at(-1)==='#expenses');
  f.window.history.forward();await until(()=>f.rendered.at(-1)==='#assets');
  f.window.history.forward();await until(()=>f.rendered.at(-1)==='#documents');
});

test('a new page request during restoration waits until the accepted entry is restored',async t=>{
  const f=fixture(t);f.route.navigate('#expenses');f.route.navigate('#assets');f.setDirty(true);
  let redirected=false;
  f.window.addEventListener('popstate',()=>{if(!redirected&&f.window.location.hash==='#expenses'){redirected=true;f.setDirty(false);f.route.navigate('#pay');}});
  f.window.history.back();await until(()=>f.rendered.at(-1)==='#pay');
  f.window.history.back();await until(()=>f.rendered.at(-1)==='#assets');
  f.window.history.back();await until(()=>f.rendered.at(-1)==='#expenses');
});

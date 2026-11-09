import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkbookService, documentsDigest, WORKBOOK_LAYOUT_VERSION, type WorkbookManifest, type WorkbookSnapshot } from './workbook.ts';

const hash = (bytes:Buffer|string) => createHash('sha256').update(bytes).digest('hex');
const oldWorkbook = Buffer.from('PK\x03\x04old workbook');
const newWorkbook = Buffer.from('PK\x03\x04new workbook');
function snapshot(revision=1):WorkbookSnapshot {
  return {generatedAt:`2026-09-24T00:00:0${revision}.000Z`, documents:[], state:{workspace:'live',revision,entities:[],accounts:[],transactions:[],obligations:[],reserves:[],positions:[],audit:[],lastBackupAt:null}};
}
async function fixture(t:TestContext, firstExport=false) {
  const directory=await mkdtemp(join(tmpdir(),'mazal-workbook-recovery-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const path=join(directory,'master.xlsx');
  const service=createWorkbookService(path,async(_,output)=>{await writeFile(output,oldWorkbook);});
  if(!firstExport)await service.refresh(snapshot());
  const oldManifest=firstExport?null:await readFile(`${path}.json`);
  const archive=join(directory,'Archive','previous-excel');
  if(oldManifest){
    await mkdir(archive,{recursive:true});
    await writeFile(join(archive,'Mazal master.xlsx'),oldWorkbook);
    await writeFile(join(archive,'Mazal master.xlsx.json'),oldManifest);
  }
  async function stage(phase:'before-workbook'|'after-workbook'|'after-manifest', bytes=newWorkbook) {
    const temporary=await mkdtemp(join(directory,'.excel-'));
    const next:WorkbookManifest={format:'mazal-workbook',version:1,layoutVersion:WORKBOOK_LAYOUT_VERSION,revision:2,documentsDigest:documentsDigest([]),sha256:hash(bytes),generatedAt:snapshot(2).generatedAt};
    const nextManifest=JSON.stringify(next);
    await writeFile(join(temporary,'workbook.xlsx'),bytes);
    await writeFile(join(temporary,'manifest.json'),nextManifest);
    const pending={format:'mazal-workbook-pending',version:1,temporary:basename(temporary),previousWorkbookSha256:firstExport?null:hash(oldWorkbook),previousManifestSha256:oldManifest?hash(oldManifest):null,nextWorkbookSha256:hash(bytes),nextManifestSha256:hash(nextManifest),nextManifest};
    await writeFile(`${path}.pending.json`,JSON.stringify(pending));
    if(phase!=='before-workbook'){
      await writeFile(path,bytes);
      await rm(join(temporary,'workbook.xlsx'));
    }
    if(phase==='after-manifest'){
      await writeFile(`${path}.json`,nextManifest);
      await rm(join(temporary,'manifest.json'));
    }
    return {temporary,nextManifest,pending};
  }
  async function assertArchive() {
    if(!oldManifest)return;
    assert.deepEqual(await readFile(join(archive,'Mazal master.xlsx')),oldWorkbook);
    assert.deepEqual(await readFile(join(archive,'Mazal master.xlsx.json')),oldManifest);
  }
  async function assertClean() {
    assert.equal((await readdir(directory)).some(name=>name.startsWith('.excel-')||name.endsWith('.pending.json')),false);
  }
  return {directory,path,service,oldManifest,stage,assertArchive,assertClean};
}

for(const phase of ['before-workbook','after-workbook','after-manifest'] as const)test(`an interrupted export recovers from ${phase} with its archive intact`,async t=>{
  const f=await fixture(t);
  const staged=await f.stage(phase);
  const restarted=createWorkbookService(f.path);
  const status=await restarted.status(snapshot(2));
  const installed=phase!=='before-workbook';
  assert.equal(status.revision,installed?2:1);
  assert.equal(status.modified,false);
  assert.equal(status.stale,!installed);
  assert.deepEqual(await readFile(f.path),installed?newWorkbook:oldWorkbook);
  assert.deepEqual(await readFile(`${f.path}.json`),installed?Buffer.from(staged.nextManifest):f.oldManifest);
  await f.assertArchive();await f.assertClean();
  assert.deepEqual(await restarted.status(snapshot(2)),status);
});

test('recovery finishes a manifest when the generated workbook bytes did not change',async t=>{
  const f=await fixture(t);
  await f.stage('after-workbook',oldWorkbook);
  assert.equal((await createWorkbookService(f.path).status(snapshot(2))).revision,2);
  assert.deepEqual(await readFile(f.path),oldWorkbook);
  await f.assertArchive();await f.assertClean();
});

for(const phase of ['before-workbook','after-workbook'] as const)test(`an interrupted first export recovers from ${phase}`,async t=>{
  const f=await fixture(t,true);
  await f.stage(phase);
  const status=await createWorkbookService(f.path).status(snapshot(2));
  assert.equal(status.available,phase==='after-workbook');
  assert.equal(status.revision,phase==='after-workbook'?2:undefined);
  await f.assertClean();
});

for(const changed of ['workbook','manifest','missing-manifest'] as const)test(`recovery preserves an externally changed ${changed} and blocks a new export`,async t=>{
  const f=await fixture(t);
  await f.stage('after-workbook');
  if(changed==='workbook')await writeFile(f.path,'user changes');
  else if(changed==='manifest')await writeFile(`${f.path}.json`,'user metadata');
  else await rm(`${f.path}.json`);
  const workbook=await readFile(f.path);
  const metadata=changed==='missing-manifest'?null:await readFile(`${f.path}.json`);
  let rendered=false;
  const restarted=createWorkbookService(f.path,async()=>{rendered=true;});
  await assert.rejects(restarted.status(),/interrupted Excel export needs review/);
  await assert.rejects(restarted.refresh(snapshot(3)),/interrupted Excel export needs review/);
  assert.equal(rendered,false);
  assert.deepEqual(await readFile(f.path),workbook);
  if(metadata)assert.deepEqual(await readFile(`${f.path}.json`),metadata);
  else await assert.rejects(readFile(`${f.path}.json`),{code:'ENOENT'});
  assert.ok((await readdir(f.directory)).includes('master.xlsx.pending.json'));
  await f.assertArchive();
});

test('recovery waits until Excel is closed before repairing the export record',async t=>{
  const f=await fixture(t);
  await f.stage('after-workbook');
  const lock=join(f.directory,'~$master.xlsx');
  await writeFile(lock,'Excel lock');
  const restarted=createWorkbookService(f.path);
  await assert.rejects(restarted.status(),/open in Excel/);
  assert.deepEqual(await readFile(`${f.path}.json`),f.oldManifest);
  assert.deepEqual(await readFile(f.path),newWorkbook);
  await rm(lock);
  assert.equal((await restarted.status()).revision,2);
  await f.assertArchive();await f.assertClean();
});

test('recovery rejects damaged journal metadata without changing either installed file',async t=>{
  const f=await fixture(t);
  const staged=await f.stage('after-workbook');
  staged.pending.nextManifest=staged.pending.nextManifest.replace('"revision":2','"revision":3');
  await writeFile(`${f.path}.pending.json`,JSON.stringify(staged.pending));
  await assert.rejects(createWorkbookService(f.path).status(),/interrupted Excel export needs review/);
  assert.deepEqual(await readFile(`${f.path}.json`),f.oldManifest);
  assert.deepEqual(await readFile(f.path),newWorkbook);
  await f.assertArchive();
});

test('the durable journal can finish metadata even when the staging directory is gone',async t=>{
  const f=await fixture(t);
  const staged=await f.stage('after-workbook');
  await rm(staged.temporary,{recursive:true});
  assert.equal((await createWorkbookService(f.path).status()).revision,2);
  assert.deepEqual(await readFile(`${f.path}.json`),Buffer.from(staged.nextManifest));
  assert.deepEqual(await readFile(f.path),newWorkbook);
  await f.assertArchive();await f.assertClean();
});

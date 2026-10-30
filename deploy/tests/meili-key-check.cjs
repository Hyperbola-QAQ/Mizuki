'use strict';
// Synthetic master and isolated disposable Meilisearch only; never use production.
if (process.env.MEILI_DISPOSABLE !== 'yes') throw new Error('disposable opt-in required');
const base = process.env.MEILI_URL;
const master = 'synthetic-only-master-key-2026';
const definitions = [
  {uid:'10b96444-970a-4aac-bd84-460255ff71e1',actions:['search'],indexes:['posts'],expiresAt:null},
  {uid:'a75d5302-eb88-411e-acf2-c7e6de06f1fe',actions:['documents.*','indexes.*','settings.*'],indexes:['posts','posts_rebuild'],expiresAt:null},
  {uid:'36ec2f88-c5bf-49a8-9a8a-3f605ffb31ad',actions:['tasks.get'],indexes:['*'],expiresAt:null},
];
async function request(method, path, key, body) {
  const r = await fetch(base + path, {method, headers:{authorization:`Bearer ${key}`,'content-type':'application/json'}, body:body && JSON.stringify(body)});
  const payload = await r.json().catch(() => null); return {status:r.status, payload};
}
(async () => {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('loopback URL required');
  const values=[];
  for (const def of definitions) { const r=await request('POST','/keys',master,def); if (r.status!==201) throw new Error(`create ${r.status}`); values.push(r.payload.key); }
  Object.assign(process.env,{MEILI_URL:base,MEILI_MASTER_KEY:master,MEILI_SEARCH_UID:definitions[0].uid,MEILI_WRITER_UID:definitions[1].uid,MEILI_TASKS_UID:definitions[2].uid,MEILI_SEARCH_KEY:values[0],MEILI_WRITER_KEY:values[1],MEILI_TASKS_KEY:values[2]});
  const {reconcile}=require('../tools/meili-key-reconciler.cjs');
  await reconcile();
  if ((await request('GET','/keys',values[0])).status !== 403) throw new Error('search key can administer keys');
  if ((await request('GET','/keys',values[2])).status !== 403 || (await request('GET','/indexes',values[2])).status !== 403) throw new Error('task key has unexpected permissions');
  for (const def of definitions) if ((await request('DELETE',`/keys/${def.uid}`,master)).status!==204) throw new Error('delete failed');
  await reconcile();
  process.env.MEILI_SEARCH_KEY='different-synthetic-key';
  // Module captures configuration once; a child process verifies mismatch separately.
  const {spawnSync}=require('node:child_process');
  const child=spawnSync(process.execPath,['-e',"require('./deploy/tools/meili-key-reconciler.cjs').reconcile().then(()=>process.exit(1),()=>process.exit(0))"],{env:process.env,stdio:'ignore'});
  if (child.status!==0) throw new Error('mismatch was accepted');
  console.log('restricted key create, verify, deletion recovery and mismatch refusal passed');
})().catch(e=>{console.error(e.message);process.exitCode=1});

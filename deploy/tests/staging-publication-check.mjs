// Writes one uniquely identified synthetic article to private staging, then deletes it.
// An interrupted create/delete leaves a private journal for operator review.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const [state,cmsInput,siteInput,confirm]=process.argv.slice(2);
if (process.argv.length!==6||confirm!=='--confirm-private-staging') throw new Error('usage: node staging-publication-check.mjs PRIVATE_STATE CMS_LOOPBACK SITE_LOOPBACK --confirm-private-staging');
function origin(raw){const u=new URL(raw);if(u.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.pathname!=='/'||u.search||u.hash||u.username||u.password)throw new Error('loopback origins required');return u.origin;}
const cms=origin(cmsInput),site=origin(siteInput);
const dir=fs.lstatSync(state),adminPath=path.join(state,'admin.json'),info=fs.lstatSync(adminPath);
if(!dir.isDirectory()||dir.isSymbolicLink()||dir.uid!==process.getuid()||(dir.mode&0o077)||!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid()||(info.mode&0o077)||info.nlink!==1) throw new Error('bootstrap state is not private');
const admin=JSON.parse(fs.readFileSync(adminPath,'utf8'));
const journal=path.join(state,'staging-check.pending'), slug='synthetic-check-'+randomUUID().replaceAll('-','');
const fd=fs.openSync(journal,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
function writeJournal(value){fs.ftruncateSync(fd,0);fs.writeSync(fd,JSON.stringify(value),0,'utf8');fs.fsyncSync(fd);}
writeJournal({slug,phase:'creating'});
const parent=fs.openSync(state,'r');fs.fsyncSync(parent);fs.closeSync(parent);
let session,id;
async function request(base,route,{method='GET',token,data}={}){
  const res=await fetch(base+route,{method,headers:{...(token?{authorization:`Bearer ${token}`} : {}),...(data?{'content-type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(15000)});
  if(!res.ok)throw new Error(`${method} ${route.split('?')[0]} returned ${res.status}`);
  return res.status===204?null:res.json();
}
async function wait(check,label){for(let i=0;i<120;i++){try{if(await check())return;}catch{}await new Promise(r=>setTimeout(r,250));}throw new Error(`timed out: ${label}`);}
const title1='暂存检验初稿',title2='暂存检验更新',model='/content-manager/collection-types/api::post.post';
const article=async()=>{const res=await fetch(site+`/posts/${slug}/`);return {status:res.status,html:await res.text()};};
const search=async(q)=>(await request(site,`/api/search?q=${encodeURIComponent(q)}`)).hits;
try {
  session=(await request(cms,'/admin/login',{method:'POST',data:{email:admin.email,password:admin.password}})).data.token;
  const data={slug,body:'暂存测试正文',metadata:{title:title1,published:'2026-10-30',tags:['暂存检验']}};
  const created=await request(cms,model,{method:'POST',token:session,data});id=(created.data||created).documentId;
  if(!id||!/^[a-zA-Z0-9]+$/.test(id))throw new Error('create response lacks a document ID');
  writeJournal({slug,id,phase:'created'});
  if((await article()).status!==404||(await search(title1)).some(hit=>hit.url.includes(slug)))throw new Error('draft exposed');
  await request(cms,`${model}/${id}/actions/publish`,{method:'POST',token:session,data:{}});
  await wait(async()=>{const p=await article();return p.status===200&&p.html.includes(title1)&&p.html.includes('暂存测试正文')&&(await search(title1)).some(hit=>hit.url.includes(slug));},'publish');
  await request(cms,`${model}/${id}`,{method:'PUT',token:session,data:{body:'暂存测试新正文',metadata:{...data.metadata,title:title2}}});
  await request(cms,`${model}/${id}/actions/publish`,{method:'POST',token:session,data:{}});
  await wait(async()=>{const p=await article();return p.status===200&&p.html.includes(title2)&&p.html.includes('暂存测试新正文')&&(await search(title2)).some(hit=>hit.url.includes(slug));},'edit');
  await request(cms,`${model}/${id}/actions/unpublish`,{method:'POST',token:session,data:{}});
  await wait(async()=>(await article()).status===404&&!(await search(title2)).some(hit=>hit.url.includes(slug)),'withdraw');
  await request(cms,`${model}/${id}/actions/publish`,{method:'POST',token:session,data:{}});
  await wait(async()=>(await search(title2)).some(hit=>hit.url.includes(slug)),'republish');
  const current=await request(cms,`${model}/${id}`,{token:session});
  if((current.data||current).slug!==slug)throw new Error('synthetic document identity changed');
  writeJournal({slug,id,phase:'deleting'});
  await request(cms,`${model}/${id}`,{method:'DELETE',token:session});
  await wait(async()=>(await article()).status===404&&!(await search(title2)).some(hit=>hit.url.includes(slug)),'delete');
  for (const spec of [
    {uid:'series-item',page:'/series/',metadata:{title:'暂存系列检验',status:'ongoing'},first:'暂存系列检验',second:'暂存系列更新'},
    {uid:'moment',page:'/moments/',metadata:{published:'2026-10-30T10:00:00Z'},first:'暂存动态检验',second:'暂存动态更新'},
  ]) {
    const route=`/content-manager/collection-types/api::${spec.uid}.${spec.uid}`;
    const contentSlug=`${slug}-${spec.uid}`;
    writeJournal({slug:contentSlug,model:spec.uid,phase:'creating'});
    const values={slug:contentSlug,body:spec.first,metadata:spec.metadata};
    const response=await request(cms,route,{method:'POST',token:session,data:values});
    const doc=(response.data||response).documentId;
    if(!doc||!/^[a-zA-Z0-9]+$/.test(doc))throw new Error('synthetic content ID missing');
    writeJournal({slug:contentSlug,id:doc,model:spec.uid,phase:'created'});
    await request(cms,`${route}/${doc}/actions/publish`,{method:'POST',token:session,data:{}});
    await wait(async()=>(await (await fetch(site+spec.page)).text()).includes(spec.first),`${spec.uid} publication`);
    const metadata=spec.uid==='series-item'?{...spec.metadata,title:spec.second}:spec.metadata;
    await request(cms,`${route}/${doc}`,{method:'PUT',token:session,data:{body:spec.second,metadata}});
    await request(cms,`${route}/${doc}/actions/publish`,{method:'POST',token:session,data:{}});
    await wait(async()=>(await (await fetch(site+spec.page)).text()).includes(spec.second),`${spec.uid} update`);
    const current=await request(cms,`${route}/${doc}`,{token:session});
    if((current.data||current).slug!==contentSlug)throw new Error('synthetic content identity changed');
    writeJournal({slug:contentSlug,id:doc,model:spec.uid,phase:'deleting'});
    await request(cms,`${route}/${doc}`,{method:'DELETE',token:session});
    await wait(async()=>!(await (await fetch(site+spec.page)).text()).includes(spec.second),`${spec.uid} deletion`);
  }
  fs.closeSync(fd);fs.unlinkSync(journal);
  const parent=fs.openSync(state,'r');fs.fsyncSync(parent);fs.closeSync(parent);
  console.log('Private staging: article draft, publish, edit, withdrawal and deletion verified; series and moments update without rebuilding.');
} catch(error) {
  try{fs.closeSync(fd);}catch{}
  console.error(`Staging verification stopped: ${error.message}. Preserve the private journal for review.`);
  process.exitCode=1;
}

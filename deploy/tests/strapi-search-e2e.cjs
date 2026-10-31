'use strict';
// Synthetic, disposable containers only. Requires already-built local images.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
if (process.env.SHIRONE_DISPOSABLE !== 'yes') throw new Error('disposable opt-in required');
const images = { db: process.env.POSTGRES_TEST_IMAGE, meili: process.env.MEILI_TEST_IMAGE, cms: process.env.CMS_TEST_IMAGE, ssr: process.env.SSR_TEST_IMAGE, reconciler: process.env.RECONCILER_TEST_IMAGE };
if (Object.values(images).some(x => !x)) throw new Error('all four test images are required');
const prefix = `shirone-e2e-${process.pid}`;
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'shirone-e2e-'));
fs.chmodSync(state, 0o700);
const docker = (...args) => execFileSync('docker', args, {encoding:'utf8', stdio:['ignore','pipe','pipe']}).trim();
const wait = async (fn, description) => {
  for (let i=0; i<240; i++) { try { const result = await fn(); if (result) return result; } catch {} await new Promise(r => setTimeout(r, 250)); }
  throw new Error(`timed out: ${description}`);
};
const origin = (name, port) => `http://127.0.0.1:${docker('port', name, `${port}/tcp`).split(':').pop()}`;
async function request(base, route, {method='GET', token, data}={}) {
  const res = await fetch(base+route, {method, headers:{...(token?{authorization:`Bearer ${token}`} : {}), ...(data?{'content-type':'application/json'}:{})}, ...(data?{body:JSON.stringify(data)}:{}), signal:AbortSignal.timeout(10000)});
  if (!res.ok) throw new Error(`${method} ${route.split('?')[0]} returned ${res.status}`);
  return res.status===204?null:res.json();
}
const run = (name, image, args) => docker('run','-d','--name',name,'--network',prefix,...args,image);
(async () => {
  try {
    Object.values(images).forEach(image => docker('image','inspect',image));
    // Docker does not publish loopback ports from an internal-only network.
    // The test uses a dedicated bridge and binds every exposed port to loopback.
    docker('network','create',prefix);
    docker('run','-d','--name',`${prefix}-db`,'--network',prefix,'--network-alias','db','--tmpfs','/tmp:rw,size=512m,uid=26,gid=26',images.db,
      'sh','-c','initdb -D /tmp/pgdata -U strapi --auth=trust >/dev/null && printf "host all all 172.16.0.0/12 trust\\n" >> /tmp/pgdata/pg_hba.conf && exec postgres -D /tmp/pgdata -h 0.0.0.0');
    await wait(() => { docker('exec',`${prefix}-db`,'pg_isready','-U','strapi','-d','postgres'); return true; },'database');
    docker('exec',`${prefix}-db`,'createdb','-U','strapi','strapi');
    const master = 'synthetic-only-master-key-2026';
    run(`${prefix}-meili`,images.meili,['--network-alias','meili','-p','127.0.0.1::7700','-e',`MEILI_MASTER_KEY=${master}`]);
    const meili = await wait(() => origin(`${prefix}-meili`,7700),'Meilisearch port');
    await wait(async () => (await fetch(meili+'/health')).ok,'Meilisearch');
    const defs = [
      {uid:randomUUID(),actions:['search'],indexes:['posts']},
      {uid:randomUUID(),actions:['documents.*','indexes.*','settings.*'],indexes:['posts','posts_rebuild']},
      {uid:randomUUID(),actions:['tasks.get'],indexes:['*']},
    ];
    const keys=[];
    for (const def of defs) keys.push((await request(meili,'/keys',{method:'POST',token:master,data:{...def,expiresAt:null}})).key);
    const env = {
      DATABASE_HOST:'db',DATABASE_PORT:'5432',DATABASE_NAME:'strapi',DATABASE_USERNAME:'strapi',DATABASE_PASSWORD:'synthetic',DATABASE_SSL:'false',
      APP_KEYS:'synthetic-app-key-one,synthetic-app-key-two',API_TOKEN_SALT:'synthetic-api-token-salt',ADMIN_JWT_SECRET:'synthetic-admin-jwt-secret',
      TRANSFER_TOKEN_SALT:'synthetic-transfer-salt',JWT_SECRET:'synthetic-jwt-secret',ENCRYPTION_KEY:'synthetic-encryption-key-32bytes',
      MEILI_URL:'http://meili:7700',MEILI_ADMIN_KEY:keys[1],MEILI_TASKS_KEY:keys[2],INTERNAL_RENDER_URL:'http://ssr:4321/api/internal/render/',INTERNAL_RENDER_TOKEN:'synthetic-render-token',
    };
    const envArgs = Object.entries(env).flatMap(([key,value])=>['-e',`${key}=${value}`]);
    run(`${prefix}-cms`,images.cms,['--network-alias','cms','-p','127.0.0.1::1337',...envArgs]);
    const cms = await wait(() => origin(`${prefix}-cms`,1337),'Strapi port');
    await wait(async () => (await fetch(cms+'/_health')).ok,'Strapi');
    execFileSync('node',['cms/scripts/prepare-bootstrap.cjs',state],{stdio:'ignore'});
    execFileSync('node',['cms/scripts/bootstrap-local.cjs',state,cms],{stdio:'ignore'});
    const admin=JSON.parse(fs.readFileSync(path.join(state,'admin.json'),'utf8'));
    const session=(await request(cms,'/admin/login',{method:'POST',data:{email:admin.email,password:admin.password}})).data.token;
    const token=(await request(cms,'/admin/api-tokens',{method:'POST',token:session,data:{name:'synthetic-e2e',type:'full-access',lifespan:604800000}})).data.accessKey;
    const reader=fs.readFileSync(path.join(state,'reader.token'),'utf8').trim();
    run(`${prefix}-ssr`,images.ssr,['--network-alias','ssr','-p','127.0.0.1::4321',
      '-e','STRAPI_URL=http://cms:1337','-e',`STRAPI_API_TOKEN=${reader}`,'-e','MEILI_URL=http://meili:7700','-e',`MEILI_SEARCH_KEY=${keys[0]}`,
      '-e','INTERNAL_RENDER_TOKEN=synthetic-render-token','-e','PROTECTED_MEDIA_SESSION_SECRET=synthetic-media-session-secret-32bytes']);
    const ssr=await wait(() => origin(`${prefix}-ssr`,4321),'SSR port');
    await wait(async()=> (await fetch(ssr+'/')).ok,'SSR');
    const homeHtml = await (await fetch(ssr+'/')).text();
    if (!homeHtml.includes('湘ICP备2024072853号-1') || !homeHtml.includes('湘公网安备43010402002198号')) throw new Error('runtime homepage footer registration is missing');
    const data={slug:'synthetic-search',body:'测试正文',metadata:{title:'动态搜索初稿',published:'2026-10-30',tags:['测试']}};
    const createdResponse=await request(cms,'/content-manager/collection-types/api::post.post',{method:'POST',token:session,data});
    const created=createdResponse.data || createdResponse;
    const id=created.documentId;
    const search=async query => (await request(ssr,`/api/search?q=${encodeURIComponent(query)}`)).hits;
    const sitemap=async () => (await fetch(ssr+'/sitemap-0.xml')).text();
    const article=async () => {
      const res=await fetch(ssr+'/posts/synthetic-search/');
      return {status:res.status,html:await res.text()};
    };
    await wait(async()=>Array.isArray(await search('动态搜索初稿')),'initial index');
    if ((await search('动态搜索初稿')).length) throw new Error('draft appeared in search');
    if ((await article()).status !== 404) throw new Error('draft article was publicly accessible');
    if ((await sitemap()).includes('synthetic-search')) throw new Error('draft appeared in sitemap');
    const action=`/content-manager/collection-types/api::post.post/${id}/actions`;
    await request(cms,`${action}/publish`,{method:'POST',token:session,data:{}});
    await wait(async()=>(await search('动态搜索初稿')).some(hit=>hit.title==='动态搜索初稿'),'publish in search');
    await wait(async()=>(await sitemap()).includes('synthetic-search'),'published sitemap');
    await wait(async()=>{const page=await article();return page.status===200&&page.html.includes('动态搜索初稿')&&page.html.includes('测试正文');},'published article');
    const snippetRoute='/content-manager/collection-types/api::snippet.snippet';
    const snippetCreated=await request(cms,snippetRoute,{method:'POST',token:session,data:{slug:'snippets/shared.md',body:'未发布片段秘密',metadata:{draft:false}}});
    const snippetId=(snippetCreated.data||snippetCreated).documentId;
    await request(cms,`/content-manager/collection-types/api::post.post/${id}`,{method:'PUT',token:session,data:{body:'引用隐私测试正文\n\n<!-- @include: snippets/shared.md -->',metadata:data.metadata}});
    await request(cms,`${action}/publish`,{method:'POST',token:session,data:{}});
    await wait(async()=>{const page=await article();return page.status===200&&page.html.includes('引用隐私测试正文')&&!page.html.includes('未发布片段秘密');},'unpublished snippet remains private');
    await request(cms,`${snippetRoute}/${snippetId}`,{method:'PUT',token:session,data:{body:'片段初版'}});
    await request(cms,`${snippetRoute}/${snippetId}/actions/publish`,{method:'POST',token:session,data:{}});
    await wait(async()=>(await article()).html.includes('片段初版'),'included published snippet');
    await request(cms,`${snippetRoute}/${snippetId}`,{method:'PUT',token:session,data:{body:'片段未发布修改秘密'}});
    const draftEditPage=await article();
    if(!draftEditPage.html.includes('片段初版') || draftEditPage.html.includes('片段未发布修改秘密')) throw new Error('draft snippet edit was exposed');
    await request(cms,`${snippetRoute}/${snippetId}`,{method:'PUT',token:session,data:{body:'片段更新'}});
    await request(cms,`${snippetRoute}/${snippetId}/actions/publish`,{method:'POST',token:session,data:{}});
    await wait(async()=>(await article()).html.includes('片段更新'),'included snippet update without article save');
    await request(cms,`${snippetRoute}/${snippetId}/actions/unpublish`,{method:'POST',token:session,data:{}});
    await wait(async()=>!(await article()).html.includes('片段更新'),'withdrawn snippet');
    await request(cms,`${snippetRoute}/${snippetId}`,{method:'DELETE',token:session});
    await request(cms,`/content-manager/collection-types/api::post.post/${id}`,{method:'PUT',token:session,data:{body:'实时修改正文',metadata:{...data.metadata,title:'动态搜索修改'}}});
    await request(cms,`${action}/publish`,{method:'POST',token:session,data:{}});
    await wait(async()=>(await search('动态搜索修改')).some(hit=>hit.title==='动态搜索修改'),'update in search');
    await wait(async()=>{const page=await article();return page.status===200&&page.html.includes('动态搜索修改')&&page.html.includes('实时修改正文');},'updated article');
    const saved=(await request(cms,`/api/posts/${id}?status=published`,{token})).data;
    if (!saved.rendered?.html?.includes('实时修改正文')) throw new Error('save-time rendered snapshot was not persisted');
    // Replace the search process with an empty data directory while both CMS
    // and SSR keep running; the same master and UUIDs must recreate the keys.
    const meiliPort = new URL(meili).port;
    docker('rm','-f',`${prefix}-meili`);
    run(`${prefix}-meili`,images.meili,['--network-alias','meili','-p',`127.0.0.1:${meiliPort}:7700`,'-e',`MEILI_MASTER_KEY=${master}`]);
    await wait(async () => (await fetch(meili+'/health')).ok,'empty Meilisearch restart');
    const unavailable=await fetch(ssr+'/api/search?q=test');
    if (unavailable.status!==503) throw new Error('search served results before key and index recovery');
    const reconcilerEnv={MEILI_URL:'http://meili:7700',MEILI_MASTER_KEY:master,MEILI_SEARCH_UID:defs[0].uid,MEILI_WRITER_UID:defs[1].uid,MEILI_TASKS_UID:defs[2].uid,MEILI_SEARCH_KEY:keys[0],MEILI_WRITER_KEY:keys[1],MEILI_TASKS_KEY:keys[2]};
    run(`${prefix}-reconciler`,images.reconciler,Object.entries(reconcilerEnv).flatMap(([key,value])=>['-e',`${key}=${value}`]));
    await wait(async()=>(await search('动态搜索修改')).some(hit=>hit.title==='动态搜索修改'),'search after data loss');
    await request(cms,`${action}/unpublish`,{method:'POST',token:session,data:{}});
    await wait(async()=>(await search('动态搜索修改')).length===0,'withdrawal from search');
    await wait(async()=>(await article()).status===404,'withdrawn article');
    await wait(async()=>!(await sitemap()).includes('synthetic-search'),'withdrawn sitemap');
    await request(cms,`${action}/publish`,{method:'POST',token:session,data:{}});
    await wait(async()=>(await search('动态搜索修改')).length>0,'republish in search');
    await request(cms,`/content-manager/collection-types/api::post.post/${id}`,{method:'DELETE',token:session});
    await wait(async()=>(await search('动态搜索修改')).length===0,'deleted article removed from search');
    await wait(async()=>(await article()).status===404,'deleted article');
    execFileSync('node',['cms/scripts/revoke-import.cjs',state,cms],{stdio:'ignore'});
    execFileSync('node',['cms/scripts/revoke-import.cjs',state,cms],{stdio:'ignore'});
    execFileSync('node',['cms/scripts/bootstrap-local.cjs',state,cms],{stdio:'ignore'});
    console.log('real Strapi, PostgreSQL, SSR and Meilisearch: draft, publish, edit, unpublish and delete passed');
  } finally {
    for (const suffix of ['reconciler','ssr','cms','meili','db']) try { docker('rm','-f',`${prefix}-${suffix}`); } catch {}
    try { docker('network','rm',prefix); } catch {}
    fs.rmSync(state,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error.message); process.exitCode=1;});

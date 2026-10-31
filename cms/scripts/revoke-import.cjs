#!/usr/bin/env node
'use strict';
// Revoke only the recorded migration token; never issue or print credentials.
const fs=require('node:fs'),path=require('node:path');
const [state,raw]=process.argv.slice(2);
if(process.argv.length!==4)throw new Error('usage: node revoke-import.cjs PRIVATE_STATE HTTP_LOOPBACK_ORIGIN');
const endpoint=new URL(raw);
if(endpoint.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)||endpoint.pathname!=='/'||endpoint.search||endpoint.hash||endpoint.username||endpoint.password)throw new Error('loopback CMS origin required');
function privateFile(name){const file=path.join(state,name),s=fs.lstatSync(file);if(s.isSymbolicLink()||!s.isFile()||s.uid!==process.getuid()||(s.mode&0o077)||s.nlink!==1)throw new Error('unsafe protected file');return fs.readFileSync(file,'utf8');}
const root=fs.lstatSync(state);if(!root.isDirectory()||root.isSymbolicLink()||root.uid!==process.getuid()||(root.mode&0o077))throw new Error('unsafe protected directory');
const admin=JSON.parse(privateFile('admin.json')),receipt=JSON.parse(privateFile('import.json'));
if(receipt.name!=='shirone-migration-import'||!Number.isInteger(receipt.id)||!Array.isArray(receipt.permissions))throw new Error('invalid import receipt');
const pending=path.join(state,'import-revoke.pending'),done=path.join(state,'import-revoked.json'),lock=path.join(state,'.bootstrap.lock');
async function request(route,options={}){const res=await fetch(endpoint.origin+route,{method:options.method||'GET',headers:{...(options.token?{authorization:`Bearer ${options.token}`} : {}),...(options.data?{'content-type':'application/json'}:{})},...(options.data?{body:JSON.stringify(options.data)}:{}),signal:AbortSignal.timeout(10000)});if(!res.ok)throw new Error(`CMS returned ${res.status}`);return res.status===204?null:res.json();}
function writeNew(file,value){const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{fs.writeFileSync(fd,value);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}const parent=fs.openSync(state,'r');fs.fsyncSync(parent);fs.closeSync(parent);}
(async()=>{
  fs.mkdirSync(lock,{mode:0o700});
  try{
    if(fs.existsSync(pending))throw new Error('revocation outcome uncertain; review required');
    const login=await request('/admin/login',{method:'POST',data:{email:admin.email,password:admin.password}}),token=login?.data?.token||login?.data?.accessToken;
    if(!token)throw new Error('administrator login failed');
    const list=(await request('/admin/api-tokens',{token}))?.data;
    if(!Array.isArray(list))throw new Error('cannot inspect tokens');
    const matches=list.filter(x=>x.name===receipt.name);
    if(fs.existsSync(done)){const saved=JSON.parse(privateFile('import-revoked.json'));if(saved.id!==receipt.id||matches.length)throw new Error('revocation state differs');console.log('Migration token already revoked.');return;}
    if(matches.length!==1||matches[0].id!==receipt.id||matches[0].type!=='custom')throw new Error('token identity mismatch');
    const detail=(await request(`/admin/api-tokens/${receipt.id}`,{token}))?.data;
    if(!detail||!Array.isArray(detail.permissions)||JSON.stringify([...detail.permissions].sort())!==JSON.stringify([...receipt.permissions].sort()))throw new Error('token permission mismatch');
    writeNew(pending,JSON.stringify({id:receipt.id,phase:'deleting'}));
    await request(`/admin/api-tokens/${receipt.id}`,{method:'DELETE',token});
    const after=(await request('/admin/api-tokens',{token}))?.data;
    if(!Array.isArray(after)||after.some(x=>x.id===receipt.id||x.name===receipt.name))throw new Error('revocation not confirmed');
    writeNew(done,JSON.stringify({id:receipt.id,name:receipt.name}));fs.unlinkSync(pending);
    const parent=fs.openSync(state,'r');fs.fsyncSync(parent);fs.closeSync(parent);
    console.log('Migration token revoked and verified.');
  } finally {fs.rmdirSync(lock);}
})().catch(error=>{console.error(`Migration token revocation held: ${error.message}`);process.exitCode=1;});

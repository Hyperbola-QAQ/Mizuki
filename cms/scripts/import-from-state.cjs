#!/usr/bin/env node
'use strict';
// Avoid putting the migration token in command arguments or shell history.
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const [state,source,base,mode]=process.argv.slice(2);
if (!state||!source||!base||!['dry-run','apply'].includes(mode)||process.argv.length!==6) throw new Error('usage: node scripts/import-from-state.cjs PRIVATE_STATE SOURCE HTTP_LOOPBACK_ORIGIN dry-run|apply');
const endpoint=new URL(base);
if (endpoint.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)||endpoint.pathname!=='/'||endpoint.search||endpoint.hash||endpoint.username||endpoint.password) throw new Error('CMS endpoint must be a loopback HTTP origin');
const root=fs.lstatSync(state);
if (!root.isDirectory()||root.isSymbolicLink()||root.uid!==process.getuid()||(root.mode&0o077)) throw new Error('bootstrap state directory is not private');
const file=path.join(state,'import.token'),info=fs.lstatSync(file);
if (!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid()||(info.mode&0o077)||info.nlink!==1) throw new Error('import token file is not private');
if (['.bootstrap.lock','reader.pending','import.pending'].some(name=>fs.existsSync(path.join(state,name)))) throw new Error('bootstrap state is incomplete');
const token=fs.readFileSync(file,'utf8').trim();
if (!token) throw new Error('import token missing');
const script=path.join(__dirname,'import-mizuki.mjs');
const args=[script,'--source',path.resolve(source),...(mode==='apply'?['--apply']:[])];
const result=spawnSync(process.execPath,args,{stdio:'inherit',env:{...process.env,STRAPI_URL:endpoint.origin,STRAPI_PUBLIC_URL:'https://hyperbola.cc',STRAPI_IMPORT_TOKEN:token}});
if (result.error) throw new Error('import process could not be started');
process.exitCode=result.status===null?1:result.status;

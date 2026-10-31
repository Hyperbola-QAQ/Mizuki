'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createHmac}=require('node:crypto');
const {makeFence}=require('../src/middlewares/backup-fence');
const secret='synthetic-secret',id='a'.repeat(32),other='b'.repeat(32);
const token=createHmac('sha256',secret).update('shirone-backup-control-v1').digest('hex');
const context=(method,path,headers={},remote='127.0.0.1')=>({method,path,req:{socket:{remoteAddress:remote}},get:name=>headers[name]||'',set(){}});
const control=(operation,lease=id,auth=token,remote)=>context('POST','/_internal/backup-lock',{'x-backup-token':auth,'x-backup-operation':operation,'x-backup-lease':lease},remote);
test('backup fence drains existing writes, blocks new writes and allows reads',async()=>{
  const fence=makeFence({secret});let finish;
  const first=context('POST','/api/posts');
  const inFlight=fence(first,()=>new Promise(resolve=>{finish=resolve;}));
  const acquire=control('acquire');const pending=fence(acquire,()=>{});
  const rejected=context('POST','/upload');await fence(rejected,()=>assert.fail('write passed lock'));assert.equal(rejected.status,503);
  let read=false;await fence(context('GET','/api/published-content/posts'),()=>{read=true;});assert.equal(read,true);
  finish();await inFlight;await pending;assert.equal(acquire.body.held,true);
  const conflicting=control('acquire',other);await fence(conflicting,()=>{});assert.equal(conflicting.status,409);
  const release=control('release');await fence(release,()=>{});assert.equal(release.body.released,true);
  let wrote=false;await fence(context('POST','/api/posts'),()=>{wrote=true;});assert.equal(wrote,true);
});
test('control requires local caller and secret and expired leases unblock writes',async()=>{
  let time=1000;const fence=makeFence({secret,now:()=>time,instance:'synthetic-instance'});
  for(const denied of [control('acquire',id,'wrong'),control('acquire',id,token,'10.0.0.5')]){await fence(denied,()=>{});assert.equal(denied.status,404);}
  const acquire=control('acquire');await fence(acquire,()=>{});assert.equal(acquire.body.instance,'synthetic-instance');
  time+=300001;
  const status=control('status');await fence(status,()=>{});assert.equal(status.body.held,false);
  let wrote=false;await fence(context('POST','/upload'),()=>{wrote=true;});assert.equal(wrote,true);
});

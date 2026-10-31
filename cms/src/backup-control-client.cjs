'use strict';
const {createHmac}=require('node:crypto');
const [operation,lease]=process.argv.slice(2);
if(!['acquire','status','release'].includes(operation)||!/^[0-9a-f]{32}$/.test(lease||'')||!process.env.JWT_SECRET)throw new Error('invalid backup control request');
const token=createHmac('sha256',process.env.JWT_SECRET).update('shirone-backup-control-v1').digest('hex');
fetch(`http://127.0.0.1:${process.env.PORT||1337}/_internal/backup-lock`,{method:'POST',headers:{'x-backup-operation':operation,'x-backup-lease':lease,'x-backup-token':token},signal:AbortSignal.timeout(25000)})
  .then(async res=>{if(!res.ok)throw new Error(`backup control returned ${res.status}`);console.log(JSON.stringify(await res.json()));})
  .catch(error=>{console.error(error.message);process.exitCode=1;});

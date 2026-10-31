'use strict';
const { createHmac, randomUUID, timingSafeEqual } = require('node:crypto');
const LEASE_MS=300000;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// A single CMS replica gates every HTTP write, including media uploads and
// admin changes. The control endpoint is reachable only from inside this pod.
function makeFence({secret=process.env.JWT_SECRET, now=Date.now, instance=randomUUID()}={}) {
  let lease=null, active=0;
  const token=secret && createHmac('sha256',secret).update('shirone-backup-control-v1').digest('hex');
  const valid = value => {
    const a=Buffer.from(value || ''),b=Buffer.from(token || '');
    return Boolean(token)&&a.length===b.length&&timingSafeEqual(a,b);
  };
  function current(){if(lease&&now()>=lease.expiresAt)lease=null;return lease;}
  return async (ctx,next)=>{
    if(ctx.path==='/_internal/backup-lock'){
      const remote=ctx.req?.socket?.remoteAddress;
      if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote)||!valid(ctx.get('x-backup-token'))){ctx.status=404;return;}
      const operation=ctx.get('x-backup-operation'),id=ctx.get('x-backup-lease');
      if(!/^[0-9a-f]{32}$/.test(id)){ctx.status=400;return;}
      if(operation==='acquire'){
        if(current()&&lease.id!==id){ctx.status=409;return;}
        if(!lease)lease={id,expiresAt:now()+LEASE_MS};
        const deadline=now()+20000;
        while(active>0&&current()&&now()<deadline)await sleep(25);
        if(active>0||!current()){if(lease?.id===id)lease=null;ctx.status=503;return;}
      } else if(operation==='release'){
        if(current()?.id!==id){ctx.status=409;return;}
        lease=null;
        ctx.body={released:true,instance};return;
      } else if(operation!=='status') {ctx.status=400;return;}
      const held=current();
      ctx.body={held:held?.id===id,instance,expiresAt:held?.id===id?held.expiresAt:null};return;
    }
    if(!['GET','HEAD','OPTIONS'].includes(ctx.method)){
      if(current()){ctx.status=503;ctx.set('Retry-After','10');ctx.body={error:'Backup in progress; retry shortly'};return;}
      active++;
      try{return await next();}finally{active--;}
    }
    return next();
  };
}
module.exports=()=>makeFence();
module.exports.makeFence=makeFence;

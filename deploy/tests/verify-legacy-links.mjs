// Read-only comparison of public old-site sitemap routes with a private staging origin.
const staging=new URL(process.argv[2]||'');
if (process.argv.length!==3||staging.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(staging.hostname)||staging.pathname!=='/'||staging.search||staging.hash) throw new Error('usage: node deploy/tests/verify-legacy-links.mjs http://127.0.0.1:PORT');
const response=await fetch('https://hyperbola.cc/sitemap-0.xml',{signal:AbortSignal.timeout(20000)});
if (!response.ok) throw new Error(`old sitemap returned ${response.status}`);
const xml=await response.text();
const urls=[...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match=>new URL(match[1].replaceAll('&amp;','&')));
if (urls.length<1||urls.some(url=>url.origin!=='https://hyperbola.cc')) throw new Error('unexpected sitemap');
const failed=[];
let cursor=0;
async function worker(){
  while(cursor<urls.length){
    const url=urls[cursor++];
    try {
      const result=await fetch(new URL(url.pathname+url.search,staging),{redirect:'follow',signal:AbortSignal.timeout(20000)});
      if (!result.ok) failed.push({path:url.pathname,status:result.status});
      else await result.body?.cancel();
    } catch {failed.push({path:url.pathname,status:'unreachable'});}
  }
}
await Promise.all(Array.from({length:5},worker));
console.log(JSON.stringify({total:urls.length,posts:urls.filter(url=>url.pathname.startsWith('/posts/')).length,failed}));
if(failed.length)process.exitCode=1;

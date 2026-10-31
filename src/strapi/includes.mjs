// Expand Shirone include comments only from published CMS snippets. No local
// filesystem access is performed, even for absolute or traversal paths.
const INCLUDE=/^([\t ]{0,3})<!--[\t ]*@include:[\t ]*([^\s]+?)(?:\{(\d*)-(\d*)\}|#([A-Za-z0-9._-]+))?[\t ]*-->[\t ]*$/u;
const FENCE=/^[\t ]{0,3}(`{3,}|~{3,})/u;
const START=/(?:#|\/\/|<!--)\s*region\s+([A-Za-z0-9._-]+)\s*(?:-->)?\s*$/u;
const END=/(?:#|\/\/|<!--)\s*endregion(?:\s+[A-Za-z0-9._-]+)?\s*(?:-->)?\s*$/u;
function keyFor(name,base) {
  if(!name||name.startsWith('/')||name.includes('\\')||name.includes('\0'))return null;
  const parts=(base?base.split('/'):[]);
  for(const part of name.split('/')) {
    if(!part||part==='.')continue;
    if(part==='..'){if(!parts.length)return null;parts.pop();}else parts.push(part);
  }
  const key=parts.join('/');
  return key.length<=512?key:null;
}
function slice(content,start,end,region){
  const lines=content.split(/\r?\n/u);
  if(region){const first=lines.findIndex(line=>line.match(START)?.[1]===region);if(first<0)return null;const last=lines.findIndex((line,index)=>index>first&&END.test(line));return last<0?null:lines.slice(first+1,last).join('\n');}
  if(start===undefined&&end===undefined)return content;
  const first=start?Number.parseInt(start,10):1,last=end?Number.parseInt(end,10):lines.length;
  return !Number.isSafeInteger(first)||!Number.isSafeInteger(last)||first<1||last<first?null:lines.slice(first-1,last).join('\n');
}
export function expandPublishedIncludes(source, snippets){
  const files=new Map();
  for(const doc of snippets){
    if(typeof doc?.slug!=='string'||typeof doc.body!=='string'||keyFor(doc.slug,'')!==doc.slug)continue;
    if(files.has(doc.slug))throw new Error('Duplicate published snippet slug');
    files.set(doc.slug,doc.body);
  }
  let count=0,total=0;
  function expand(text,base,stack){
    let fence=null;const output=[];
    for(const line of String(text).split(/\r?\n/u)){
      const marker=line.match(FENCE);
      if(marker){if(!fence)fence={char:marker[1][0],length:marker[1].length};else if(marker[1][0]===fence.char&&marker[1].length>=fence.length)fence=null;output.push(line);continue;}
      const match=!fence&&line.match(INCLUDE);
      if(!match){output.push(line);continue;}
      const [,indent,name,start,end,region]=match,key=keyFor(name,base),body=key&&files.get(key);
      if(body===undefined||body===null||stack.includes(key)||stack.length>=8||count>=128){output.push(line);continue;}
      const selection=slice(body,start,end,region);
      if(selection===null||(total+=selection.length)>2*1024*1024){output.push(line);continue;}
      count++;
      const nextBase=key.includes('/')?key.slice(0,key.lastIndexOf('/')):'';
      output.push(...expand(selection,nextBase,[...stack,key]).split('\n').map(child=>indent+child));
    }
    return output.join('\n');
  }
  return expand(source,'',[]);
}

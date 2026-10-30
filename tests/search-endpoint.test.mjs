import assert from 'node:assert/strict';
import test from 'node:test';
import { GET } from '../src/search/endpoint.ts';

test('search checks every result against published Strapi content', async () => {
  const previous = globalThis.fetch;
  const vars = ['MEILI_URL', 'MEILI_SEARCH_KEY', 'STRAPI_URL', 'STRAPI_API_TOKEN'];
  const old = Object.fromEntries(vars.map(key => [key, process.env[key]]));
  Object.assign(process.env, { MEILI_URL: 'http://search', MEILI_SEARCH_KEY: 'search', STRAPI_URL: 'http://cms', STRAPI_API_TOKEN: 'read' });
  globalThis.fetch = async (url) => {
    if (url.startsWith('http://search')) return Response.json({hits: [
      {id:'published1',url:'/posts/visible/',title:'stale'},
      {id:'withdrawn1',url:'/posts/withdrawn/'},
      {id:'protected1',url:'/posts/protected/'},
    ]});
    if (url.includes('withdrawn1')) return new Response('', {status:404});
    if (url.includes('protected1')) return Response.json({data:{publishedAt:'2026-01-01', metadata:{password:'secret'}}});
    return Response.json({data:{slug:'visible',publishedAt:'2026-01-01', metadata:{title:'Current', description:'Public'}}});
  };
  try {
    const response = await GET({url:new URL('http://site/api/search?q=test')});
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {hits:[{url:'/posts/visible/',title:'Current',description:'Public'}]});
    assert.equal(response.headers.get('cache-control'), 'no-store');
  } finally {
    globalThis.fetch = previous;
    for (const key of vars) old[key] === undefined ? delete process.env[key] : process.env[key] = old[key];
  }
});

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const { indexDocument, reconcile, rebuild } = require('../cms/src/search/meilisearch.js');

const post = { documentId: 'doc123', slug: 'Tech/示例', publishedAt: '2026-01-01', body: '公开正文', metadata: { title: '标题', tags: ['标签'] } };
test('only published, unprotected documents become searchable', () => {
  assert.equal(indexDocument(post).url, '/posts/Tech/%E7%A4%BA%E4%BE%8B/');
  for (const change of [{publishedAt: null}, {metadata: {draft: true}}, {metadata: {encrypted: true}}, {metadata: {password: 'secret'}}]) assert.equal(indexDocument({...post, ...change}), null);
  assert.equal(indexDocument({...post, metadata: {permalink: '../unsafe'}}), null);
});

test('reconcile removes withdrawn content and rebuild swaps a complete index', async () => {
  const oldFetch = globalThis.fetch;
  const oldEnv = { ...process.env };
  process.env.MEILI_URL = 'http://meili.invalid'; process.env.MEILI_ADMIN_KEY = 'secret';
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({url: String(url), method: init.method, body: init.body});
    if (String(url).includes('/tasks/')) return Response.json({status: 'succeeded'});
    if (init.method === 'GET' && String(url).endsWith('/documents/shironeReadiness')) return Response.json({id:'shironeReadiness', kind:'readiness', generation:'12345678-1234-4234-8234-123456789abc'});
    if (init.method === 'GET' && String(url).endsWith('/indexes/posts_rebuild')) return new Response(null, {status:404});
    if (init.method === 'GET') return Response.json({uid: 'posts'});
    return Response.json({taskUid: calls.length});
  };
  try {
    const strapi = {documents: () => ({findOne: async () => null, findMany: async () => [post]})};
    await reconcile(strapi, 'doc123');
    assert.ok(calls.some(c => c.method === 'DELETE' && c.url.endsWith('/documents/doc123')));
    await rebuild(strapi);
    assert.ok(calls.some(c => c.url.endsWith('/swap-indexes') && c.method === 'POST'));
    assert.ok(calls.some(c => c.body?.includes('公开正文')));
  } finally { globalThis.fetch = oldFetch; process.env = oldEnv; }
});

test('a staging index left by a previous process is never automatically deleted', async () => {
  const oldFetch = globalThis.fetch;
  const oldEnv = { ...process.env };
  process.env.MEILI_URL = 'http://meili.invalid'; process.env.MEILI_ADMIN_KEY = 'writer';
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({url: String(url), method: init.method});
    return Response.json({uid: 'existing'});
  };
  try {
    await assert.rejects(rebuild({documents: () => ({findMany: async () => []})}), /operator recovery required/);
    assert.ok(!calls.some(call => call.method === 'DELETE'));
    assert.ok(!calls.some(call => call.method === 'POST'));
  } finally { globalThis.fetch = oldFetch; process.env = oldEnv; }
});

test('unknown swap outcome leaves staging index intact for recovery', async () => {
  const oldFetch = globalThis.fetch;
  const oldEnv = { ...process.env };
  process.env.MEILI_URL = 'http://meili.invalid'; process.env.MEILI_ADMIN_KEY = 'writer'; process.env.MEILI_TASKS_KEY = 'tasks';
  const calls = [];
  let swapId = -1;
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, method: init.method });
    if (init.method === 'GET' && path === '/indexes/posts_rebuild') return new Response(null, {status:404});
    if (path.startsWith('/tasks/')) {
      if (path === `/tasks/${swapId}`) return new Response(null, {status:404});
      assert.equal(init.headers.Authorization, 'Bearer tasks');
      return Response.json({status:'succeeded'});
    }
    if (init.method === 'GET') return Response.json({uid:'posts'});
    const id = calls.length;
    if (path === '/swap-indexes') swapId = id;
    return Response.json({taskUid:id});
  };
  try {
    await assert.rejects(rebuild({documents: () => ({findMany: async () => []})}), /404/);
    assert.ok(!calls.some(call => call.method === 'DELETE' && call.path === '/indexes/posts_rebuild'));
    const before = calls.length;
    await assert.rejects(rebuild({documents: () => ({findMany: async () => []})}), /outcome uncertain/);
    assert.equal(calls.length, before);
  } finally { globalThis.fetch = oldFetch; process.env = oldEnv; }
});

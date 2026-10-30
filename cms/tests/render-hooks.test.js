'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { registerRenderHooks, sourceHash } = require('../src/render-hooks');

function harness(render, previous = {}) {
  let middleware;
  const strapi = {
    documents: Object.assign(() => ({ findOne: async () => previous }), { use(fn) { middleware = fn; } }),
    log: { warn() {} },
  };
  registerRenderHooks(strapi, render);
  return middleware;
}

test('renders updated Markdown before saving, including fields absent from partial updates', async () => {
  const old = { body: 'old', metadata: { title: 'First' } };
  const middleware = harness(async (body, metadata) => ({ html: `<p>${body}</p>`, metadata: {}, sourceHash: sourceHash(body, metadata) }), old);
  const data = { body: 'new' };
  assert.equal(await middleware({ uid: 'api::post.post', action: 'update', params: { documentId: 'one', data } }, async () => 'saved'), 'saved');
  assert.equal(data.rendered.html, '<p>new</p>');
  assert.equal(data.rendered.sourceHash, sourceHash('new', old.metadata));
});

test('renderer failure or protected content never persists stale or plaintext HTML', async () => {
  let calls = 0;
  const broken = harness(async () => { calls++; throw new Error('unavailable'); });
  const data = { body: 'secret?', metadata: { title: 'x' }, rendered: { html: 'stale' } };
  await broken({ uid: 'api::post.post', action: 'create', params: { data } }, async () => 'saved');
  assert.equal(data.rendered, null);
  const protectedData = { body: 'plaintext', metadata: { title: 'x', encrypted: true, password: 'x' }, rendered: { html: 'unsafe' } };
  await broken({ uid: 'api::post.post', action: 'create', params: { data: protectedData } }, async () => 'saved');
  assert.equal(protectedData.rendered, null);
  assert.equal(calls, 1);
});

test('hash is stable across PostgreSQL JSON key reordering', () => {
  assert.equal(sourceHash('x', { z: 1, nested: { b: 2, a: 1 } }), sourceHash('x', { nested: { a: 1, b: 2 }, z: 1 }));
  assert.notEqual(sourceHash('x', { a: [1, 2] }), sourceHash('x', { a: [2, 1] }));
});

test('renderer protocol checks bearer, version, source hash, and rejects stale responses', async () => {
  const { requestRender } = require('../src/render-hooks');
  const prevUrl = process.env.INTERNAL_RENDER_URL;
  const prevToken = process.env.INTERNAL_RENDER_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.INTERNAL_RENDER_URL = 'http://renderer.internal/api/internal/render';
  process.env.INTERNAL_RENDER_TOKEN = 'test-only';
  const metadata = { title: 'x', nested: { z: 2, a: 1 } };
  try {
    globalThis.fetch = async (_url, init) => {
      assert.equal(init.headers.Authorization, 'Bearer test-only');
      assert.deepEqual(JSON.parse(init.body), { body: 'example', metadata });
      return Response.json({ version: 1, html: '<p>example</p>', metadata: {}, sourceHash: sourceHash('example', metadata) });
    };
    assert.equal((await requestRender('example', metadata)).version, 1);
    globalThis.fetch = async () => Response.json({ version: 1, html: 'stale', metadata: {}, sourceHash: 'wrong' });
    await assert.rejects(requestRender('example', metadata), /invalid result/);
  } finally {
    globalThis.fetch = previousFetch;
    if (prevUrl === undefined) delete process.env.INTERNAL_RENDER_URL; else process.env.INTERNAL_RENDER_URL = prevUrl;
    if (prevToken === undefined) delete process.env.INTERNAL_RENDER_TOKEN; else process.env.INTERNAL_RENDER_TOKEN = prevToken;
  }
});

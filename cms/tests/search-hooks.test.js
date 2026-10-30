'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { registerSearchHooks } = require('../src/search-hooks');

test('reconciles successful post mutations and does not fail an already committed write', async () => {
  let middleware;
  const errors = [];
  const strapi = { documents: { use(fn) { middleware = fn; } }, log: { error(msg) { errors.push(msg); } } };
  const calls = [];
  registerSearchHooks(strapi, async (_strapi, id) => { calls.push(id); throw new Error('index unavailable'); });
  const result = { documentId: 'post1' };
  assert.equal(await middleware({ uid: 'api::post.post', action: 'publish', params: { documentId: 'post1' } }, async () => result), result);
  assert.deepEqual(calls, ['post1']);
  assert.equal(errors.length, 1);
  await middleware({ uid: 'api::post.post', action: 'findOne', params: {} }, async () => result);
  assert.deepEqual(calls, ['post1']);
  await assert.rejects(middleware({ uid: 'api::post.post', action: 'delete', params: { documentId: 'post1' } }, async () => { throw new Error('write failed'); }), /write failed/);
  assert.deepEqual(calls, ['post1']);
});

test('search monitor promptly rebuilds when service returns or marker disappears', async () => {
  const { startSearchRebuild } = require('../src/search-hooks');
  let state = 'ready';
  let rebuilds = 0;
  const stop = startSearchRebuild({ log: { error() {} } }, async () => { rebuilds++; }, async () => {
    if (state === 'down') throw new Error('unavailable');
    return state === 'ready';
  }, 15, 60000);
  const waitUntil = async (check) => {
    for (let i = 0; i < 100; i++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
    assert.fail('monitor did not react');
  };
  try {
    await waitUntil(() => rebuilds === 1);
    state = 'down';
    await new Promise((resolve) => setTimeout(resolve, 40));
    state = 'ready';
    await waitUntil(() => rebuilds === 2);
    state = 'missing';
    await waitUntil(() => rebuilds >= 3);
  } finally { stop(); }
});

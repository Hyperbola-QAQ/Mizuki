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

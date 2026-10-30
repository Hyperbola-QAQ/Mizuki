'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { registerMigrationGuard } = require('../src/migration-guard');

function harness(metadata) {
  let middleware;
  const strapi = { documents: Object.assign(() => ({ findOne: async () => ({ metadata }) }), { use(fn) { middleware = fn; } }) };
  registerMigrationGuard(strapi);
  return middleware;
}

test('blocks publication of archived MDX while allowing draft edits', async () => {
  const mdx = { migration: { format: 'mdx', requiresManualConversion: true } };
  const run = harness(mdx);
  const next = async () => 'ok';
  const context = { uid: 'api::post.post', action: 'publish', params: { documentId: 'x' } };
  await assert.rejects(run(context, next), /MDX must be converted/);
  assert.equal(await run({ ...context, action: 'update', params: { documentId: 'x', status: 'draft' } }, next), 'ok');
  await assert.rejects(run({ ...context, action: 'create', params: { status: 'published', data: { metadata: mdx } } }, next), /MDX must be converted/);
  assert.equal(await harness({ migration: { format: 'mdx', requiresManualConversion: false } })(context, next), 'ok');
});

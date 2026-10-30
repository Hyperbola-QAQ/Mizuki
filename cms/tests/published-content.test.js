'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { listPublished } = require('../src/published-content');

test('ignores status injection and exposes only published approved metadata', async () => {
  const calls = [];
  const strapi = { documents(uid) { return {
    async findMany(args) { calls.push({ uid, ...args }); return [
      { documentId: '1', slug: 'public', publishedAt: '2026-01-01', metadata: { title: 'Public', password: 'p', migration: { source: 'PRIVATE' }, _mizukiMigration: { sha256: 'secret' } } },
      { documentId: '2', slug: 'draft', publishedAt: null, metadata: { title: 'DRAFT' } },
    ]; },
    async count(args) { calls.push({ uid, ...args }); return 1; },
  }; } };
  const response = await listPublished(strapi, 'posts', { status: 'draft', filters: { any: 'thing' }, pagination: { page: '1', pageSize: '10' } });
  assert.equal(response.data.length, 1);
  assert.deepEqual(response.data[0].metadata, { title: 'Public', password: 'p' });
  assert.ok(calls.every((call) => call.status === 'published' && !call.filters));
  assert.equal(await listPublished(strapi, '../posts', {}), null);
  await assert.rejects(listPublished(strapi, 'posts', { pagination: { page: '0' } }), /Invalid pagination/);
});

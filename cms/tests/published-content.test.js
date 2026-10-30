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
  assert.equal(await listPublished(strapi, '__proto__', {}), null);
  await assert.rejects(listPublished(strapi, 'posts', { pagination: { page: '0' } }), /Invalid pagination/);
});

test('rejects stale or protected snapshots and strips private nested snapshot data', () => {
  const { documentForSsr } = require('../src/published-content');
  const { sourceHash } = require('../src/source-hash');
  const metadata = { title: 'visible', published: '2025-01-01', migration: { source: 'private' } };
  const sanitized = { title: 'visible', published: '2025-01-01' };
  const doc = { documentId: '1', slug: 'one', body: 'Hello', metadata, publishedAt: '2025',
    rendered: { version: 1, html: '<p>Hello</p>', sourceHash: sourceHash('Hello', sanitized),
      metadata: { headings: [], secret: 'private', frontmatter: { title: 'visible', words: 3, password: 'private', migration: { source: 'private' } } } } };
  const result = documentForSsr('posts', doc);
  assert.equal(result.rendered.metadata.frontmatter.words, 3);
  assert.equal(result.rendered.metadata.frontmatter.password, undefined);
  assert.equal(result.rendered.metadata.secret, undefined);
  assert.equal(result.metadata.migration, undefined);
  assert.equal(documentForSsr('posts', { ...doc, body: 'changed' }).rendered, undefined);
  assert.equal(documentForSsr('posts', { ...doc, metadata: { ...metadata, encrypted: true, password: 'p' } }).rendered, undefined);
});

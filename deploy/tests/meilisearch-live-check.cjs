const assert = require('node:assert/strict');
const { rebuild, reconcile } = require('../../cms/src/search/meilisearch.js');
if (process.env.MEILI_DISPOSABLE !== 'yes') throw new Error('Set MEILI_DISPOSABLE=yes only for an isolated disposable Meilisearch instance');
process.env.MEILI_INDEX = `shirone_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const published = { documentId: 'public001', slug: 'stars', body: '星际旅程初版', publishedAt: '2026-10-01T00:00:00Z', metadata: { title: '星际文章', tags: ['星空'] } };
const encrypted = { documentId: 'private001', slug: 'private', body: '绝密内容', publishedAt: '2026-10-01T00:00:00Z', metadata: { title: '秘密', encrypted: true } };
let documents = [published, encrypted];
const strapi = { documents: () => ({ findMany: async ({ start, limit }) => documents.slice(start, start + limit), findOne: async ({ documentId }) => documents.find((item) => item.documentId === documentId) ?? null }) };
async function search(q) {
  const r = await fetch(`${process.env.MEILI_URL}/indexes/${process.env.MEILI_INDEX}/search`, { method: 'POST', headers: { 'Authorization': `Bearer ${process.env.MEILI_ADMIN_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ q }) });
  assert.equal(r.status, 200);
  return (await r.json()).hits;
}
(async () => {
  await rebuild(strapi);
  assert.equal((await search('星际')).length, 1);
  assert.equal((await search('绝密')).length, 0);
  published.metadata.title = '银河新篇'; published.body = '银河内容';
  await reconcile(strapi, published.documentId);
  assert.equal((await search('银河')).length, 1);
  assert.equal((await search('星际')).length, 0);
  documents = [];
  await reconcile(strapi, published.documentId);
  assert.equal((await search('银河')).length, 0);
  const cleanup = await fetch(`${process.env.MEILI_URL}/indexes/${process.env.MEILI_INDEX}`, { method: 'DELETE', headers: { Authorization: `Bearer ${process.env.MEILI_ADMIN_KEY}` } });
  assert.equal(cleanup.status, 202);
  console.log('Meilisearch live rebuild, update, delete and encrypted exclusion passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

#!/usr/bin/env node
// This test intentionally writes the supplied archive into a disposable CMS.
// It refuses non-loopback CMS endpoints and non-empty databases.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { prepare, apply } from './import-mizuki.mjs';

const { STRAPI_URL, STRAPI_IMPORT_TOKEN, STRAPI_PUBLIC_URL, ISOLATED_CMS_CONFIRM } = process.env;
if (!STRAPI_URL || !STRAPI_IMPORT_TOKEN || !STRAPI_PUBLIC_URL || ISOLATED_CMS_CONFIRM !== 'disposable') {
  throw new Error('Set STRAPI_URL, STRAPI_IMPORT_TOKEN, STRAPI_PUBLIC_URL and ISOLATED_CMS_CONFIRM=disposable');
}
const url = new URL(STRAPI_URL);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Only a loopback CMS is allowed');
const origin = new URL(STRAPI_PUBLIC_URL);
if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) {
  throw new Error('STRAPI_PUBLIC_URL must be a public HTTPS origin');
}
if (process.argv.length !== 3) throw new Error('usage: node scripts/verify-isolated-import.mjs /path/to/archived/mizuki');
const cfg = { base: url.href.replace(/\/$/, ''), token: STRAPI_IMPORT_TOKEN, publicOrigin: origin.origin };

async function list(status) {
  const result = [];
  for (let page = 1; ; page++) {
    const params = new URLSearchParams({ status, 'pagination[pageSize]': '100', 'pagination[page]': String(page) });
    const response = await fetch(`${cfg.base}/api/posts?${params}`, {
      headers: { Authorization: `Bearer ${cfg.token}` }, signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`posts ${status} read returned ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload?.data) || !Number.isInteger(payload?.meta?.pagination?.pageCount)) throw new Error('invalid posts response');
    result.push(...payload.data);
    if (page >= payload.meta.pagination.pageCount) return result;
  }
}

const { posts, issues, warnings } = await prepare(resolve(process.argv[2]));
assert.deepEqual(issues, [], 'archive has blocking media or format issues');
assert.equal((await list('draft')).length, 0, 'CMS must start with an empty posts collection');
assert.equal((await list('published')).length, 0, 'CMS must start with an empty posts collection');
const first = await apply(posts, cfg);
assert.equal(first.posts, posts.length);
const second = await apply(posts, cfg);
assert.deepEqual(second, { posts: 0, skipped: posts.length, uploadedAssets: 0 });
const published = await list('published');
const drafts = await list('draft');
assert.equal(drafts.length, posts.length);
assert.equal(published.length, posts.filter((post) => post.metadata.draft !== true).length);
const draftBySlug = new Map(drafts.map((doc) => [doc.slug, doc]));
const publishedIds = new Set(published.map((doc) => doc.slug));
for (const source of posts) {
  const doc = draftBySlug.get(source.slug);
  assert.ok(doc, `missing imported slug ${source.slug}`);
  assert.equal(doc.metadata?._mizukiMigration?.sha256, source.metadata._mizukiMigration.sha256);
  assert.equal(publishedIds.has(source.slug), source.metadata.draft !== true);
  assert.equal(doc.metadata.title, source.metadata.title);
  if (!source.assets.size) assert.equal(doc.body || '', source.body);
  if (source.metadata.migration?.format === 'mdx') assert.equal(doc.metadata.migration.source, source.metadata.migration.source);
  for (const media of doc.metadata?._mizukiMigration?.mediaPaths ?? []) assert.ok(media.startsWith('/uploads/'));
}
console.log(JSON.stringify({ result: 'PASS', imported: first.posts, published: published.length,
  drafts: posts.filter((post) => post.metadata.draft === true).length,
  uploadedAssets: first.uploadedAssets, skippedOnRetry: second.skipped, warnings: warnings.length }));

'use strict';

const UID = 'api::post.post';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let tail = Promise.resolve();

// Serialize hooks and rebuilds in this process so an old snapshot cannot win a race
// against a publication event. Deploy the CMS as a single writer.
function serialized(fn) {
  const next = tail.then(fn, fn);
  tail = next.catch(() => {});
  return next;
}

function config() {
  const base = process.env.MEILI_URL;
  const key = process.env.MEILI_ADMIN_KEY;
  const index = process.env.MEILI_INDEX || 'posts';
  if (!base || !key || !/^[a-zA-Z0-9_-]+$/.test(index)) throw new Error('Meilisearch configuration missing or invalid');
  return { base: base.replace(/\/$/, ''), key, index };
}

async function request(method, path, body) {
  const { base, key } = config();
  const response = await fetch(`${base}${path}`, {
    method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    const error = new Error(`Meilisearch request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

async function task(method, path, body) {
  const submitted = await request(method, path, body);
  if (!Number.isSafeInteger(submitted?.taskUid)) throw new Error('Meilisearch task ID missing');
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const state = await request('GET', `/tasks/${submitted.taskUid}`);
    if (state.status === 'succeeded') return;
    if (state.status === 'failed' || state.status === 'canceled') throw new Error(`Meilisearch task ${state.status}`);
    await sleep(150);
  }
  throw new Error('Meilisearch task timeout');
}

function indexDocument(post) {
  const m = post?.metadata || {};
  if (!post?.documentId || !post?.slug || !post.publishedAt || m.draft || m.encrypted || (m.password !== undefined && String(m.password).trim())) return null;
  // These are internal paths only; reject a hostile or malformed permalink.
  const permalink = typeof m.permalink === 'string' ? m.permalink.trim().replace(/^\/+|\/+$/g, '') : '';
  const alias = typeof m.alias === 'string' ? m.alias.trim().replace(/^\/+|\/+$/g, '') : '';
  const raw = permalink || `posts/${alias || post.slug}`;
  if (raw.split('/').some((segment) => !segment || segment === '.' || segment === '..')) return null;
  const path = '/' + raw.split('/').map(encodeURIComponent).join('/') + '/';
  return { id: post.documentId, url: path, title: String(m.title || post.slug), description: String(m.description || ''), body: String(post.body || ''), tags: Array.isArray(m.tags) ? m.tags.map(String) : [], updatedAt: post.updatedAt || '' };
}

async function ensureIndex(index) {
  try { await request('GET', `/indexes/${index}`); }
  catch (error) {
    if (error.status !== 404) throw error;
    await task('POST', '/indexes', { uid: index, primaryKey: 'id' });
  }
}

async function reconcile(strapi, documentId) {
  return serialized(async () => {
    const { index } = config();
    await ensureIndex(index);
    const post = await strapi.documents(UID).findOne({ documentId, status: 'published' });
    const doc = indexDocument(post);
    if (doc) await task('POST', `/indexes/${index}/documents?primaryKey=id`, [doc]);
    else await task('DELETE', `/indexes/${index}/documents/${encodeURIComponent(documentId)}`);
  });
}

async function rebuild(strapi) {
  return serialized(async () => {
    const { index } = config();
    const temp = `${index}_build_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    let created = false;
    await ensureIndex(index);
    try {
      await task('POST', '/indexes', { uid: temp, primaryKey: 'id' });
      created = true;
      await task('PATCH', `/indexes/${temp}/settings`, { searchableAttributes: ['title', 'description', 'body', 'tags'], displayedAttributes: ['id', 'url', 'title', 'description'] });
      const limit = 100;
      for (let start = 0; ; start += limit) {
        const rows = await strapi.documents(UID).findMany({ status: 'published', start, limit, sort: ['documentId:asc'] });
        const docs = rows.map(indexDocument).filter(Boolean);
        if (docs.length) await task('POST', `/indexes/${temp}/documents?primaryKey=id`, docs);
        if (rows.length < limit) break;
      }
      await task('POST', '/swap-indexes', [{ indexes: [index, temp] }]);
    } finally {
      if (created) await task('DELETE', `/indexes/${temp}`).catch(() => {});
    }
  });
}

module.exports = { reconcile, rebuild, indexDocument };

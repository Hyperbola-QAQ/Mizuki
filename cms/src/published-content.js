'use strict';

const { sourceHash } = require('./source-hash');

const PUBLIC_FIELDS = {
  posts: ['title','published','publishedAt','updated','updatedAt','pinned','draft','comment','description','image','tags','category','series','seriesOrder','lang','encrypted','password','passwordHint','hideHomeContent','alias','permalink'],
  'series-items': ['title','status','defaultCategory'],
  moments: ['published','pinned','location','mood','tags','images','draft'],
  snippets: ['draft'],
};
const TYPES = { posts: 'api::post.post', 'series-items': 'api::series-item.series-item', moments: 'api::moment.moment', snippets: 'api::snippet.snippet' };

function publicMetadata(kind, metadata) {
  const source = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
  return Object.fromEntries((PUBLIC_FIELDS[kind] || []).filter((key) => Object.hasOwn(source, key)).map((key) => [key, source[key]]));
}

function safeSnapshot(doc, metadata) {
  const snapshot = doc.rendered;
  if (metadata.encrypted || (metadata.password != null && String(metadata.password).trim()) ||
      snapshot?.version !== 1 || typeof snapshot.html !== 'string' || !snapshot.metadata ||
      snapshot.sourceHash !== sourceHash(doc.body ?? '', metadata)) return undefined;
  const source = snapshot.metadata;
  const front = source.frontmatter && typeof source.frontmatter === 'object' ? source.frontmatter : {};
  const fields = [...PUBLIC_FIELDS.posts.filter((key) => key !== 'password'), 'minutes', 'words', 'excerpt', 'markdownSyntaxes'];
  const frontmatter = Object.fromEntries(fields.filter((key) => Object.hasOwn(front, key)).map((key) => [key, front[key]]));
  const headers = Array.isArray(source.headings) ? source.headings.map((heading) => ({ depth: heading.depth, slug: heading.slug, text: heading.text })) : [];
  const strings = (value) => Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
  return { version: 1, html: snapshot.html, sourceHash: snapshot.sourceHash,
    metadata: { headings: headers, localImagePaths: strings(source.localImagePaths), remoteImagePaths: strings(source.remoteImagePaths), frontmatter } };
}

function documentForSsr(kind, doc) {
  const metadata = publicMetadata(kind, doc.metadata);
  if (metadata.draft === true || !doc.publishedAt) return null;
  const rendered = kind === 'posts' ? safeSnapshot(doc, metadata) : undefined;
  return { documentId: doc.documentId, slug: doc.slug, body: doc.body, metadata, updatedAt: doc.updatedAt,
    ...(rendered ? { rendered } : {}) };
}

function positiveInteger(value, fallback, max) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number <= max ? number : null;
}

async function listPublished(strapi, kind, query = {}) {
  if (!Object.hasOwn(TYPES, kind)) return null;
  const uid = TYPES[kind];
  const page = positiveInteger(query.pagination?.page, 1, 10000);
  const pageSize = positiveInteger(query.pagination?.pageSize, 100, 100);
  if (!page || !pageSize) throw new Error('Invalid pagination');
  const service = strapi.documents(uid);
  // Never pass client-provided status, filters, fields, populate or locale.
  const [rows, total] = await Promise.all([
    service.findMany({ status: 'published', start: (page - 1) * pageSize, limit: pageSize, sort: ['slug:asc', 'documentId:asc'] }),
    service.count({ status: 'published' }),
  ]);
  return { data: rows.map((doc) => documentForSsr(kind, doc)).filter(Boolean),
    meta: { pagination: { page, pageSize, pageCount: Math.ceil(total / pageSize), total } } };
}

module.exports = { TYPES, publicMetadata, documentForSsr, listPublished };

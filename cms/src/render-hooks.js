'use strict';

const { sourceHash } = require('./source-hash');
const { publicMetadata } = require('./published-content');
const POST_UID = 'api::post.post';
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function isProtected(metadata) {
  return Boolean(metadata?.encrypted || (metadata?.password != null && String(metadata.password).trim()));
}

async function requestRender(body, metadata) {
  const endpoint = process.env.INTERNAL_RENDER_URL;
  const token = process.env.INTERNAL_RENDER_TOKEN;
  if (!endpoint || !token || Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) return null;
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('invalid renderer URL');
  // Astro is configured with trailingSlash=always; avoid POST-to-GET redirects.
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  const response = await fetch(url, {
    redirect: 'error',
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body, metadata }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`renderer returned ${response.status}`);
  const result = await response.json();
  if (result?.version !== 1 || typeof result?.html !== 'string' || !result.metadata || typeof result.metadata !== 'object' ||
      result.sourceHash !== sourceHash(body, metadata)) throw new Error('renderer returned an invalid result');
  return { version: 1, html: result.html, metadata: result.metadata, sourceHash: result.sourceHash };
}

function registerRenderHooks(strapi, render = requestRender) {
  strapi.documents.use(async (context, next) => {
    if (context.uid !== POST_UID || !['create', 'update'].includes(context.action)) return next();
    const params = context.params || {};
    const data = params.data;
    if (!data || typeof data !== 'object') return next();
    // Never allow a caller to set trusted HTML. Regenerate or clear it.
    delete data.rendered;
    if (context.action === 'update' && !Object.hasOwn(data, 'body') && !Object.hasOwn(data, 'metadata')) return next();
    let previous;
    try {
      if (context.action === 'update' && (!Object.hasOwn(data, 'body') || !Object.hasOwn(data, 'metadata'))) {
        previous = await strapi.documents(POST_UID).findOne({ documentId: params.documentId, status: 'draft' });
      }
      const body = data.body ?? previous?.body ?? '';
      const metadata = data.metadata ?? previous?.metadata;
      // Fail closed for inaccessible data, protected posts and non-Markdown drafts.
      if (typeof body !== 'string' || !metadata || typeof metadata !== 'object' ||
          isProtected(metadata) || metadata.migration?.format === 'mdx') {
        data.rendered = null;
      } else {
        data.rendered = await render(body, publicMetadata('posts', metadata));
      }
    } catch (error) {
      data.rendered = null;
      // Do not log content or credentials. The frontend can render on demand.
      strapi.log.warn('[render] pre-render unavailable; the site will render this entry on demand');
    }
    return next();
  });
}

module.exports = { registerRenderHooks, requestRender, sourceHash, isProtected };

#!/usr/bin/env node
/** Import a checked-out Mizuki archive. Dry-run by default; never overwrites entries. */
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { slug as githubSlug } from 'github-slugger';

const supported = /\.(?:md|mdx)$/i;
const remote = /^(?:https?:|data:|\/\/|#)/i;

async function walk(root) {
  const files = [];
  async function visit(dir) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      if (item.name.startsWith('_') || item.name.startsWith('.')) continue;
      const target = path.join(dir, item.name);
      if (item.isDirectory()) await visit(target);
      else if (item.isFile() && supported.test(item.name)) files.push(target);
    }
  }
  await visit(root);
  return files.sort();
}

export function astroSlug(relative, metadata) {
  if (metadata.slug) return String(metadata.slug);
  return relative.replace(/\.(md|mdx)$/i, '').split(path.sep)
    .map((part) => githubSlug(part)).join('/').replace(/\/index$/, '');
}

function localReferences(body, image) {
  const found = [];
  // Root paths are considered only for media (not ordinary navigation links).
  for (const match of body.matchAll(/!\[[^\]\n]*\]\(((?:\.{1,2}\/|\/(?!\/))[^\s)]+)(?:\s+['"][^)]*['"])?\)/g)) found.push(match[1]);
  for (const match of body.matchAll(/<(?:img|audio|video|source)\b[^>]*?\s(?:src|poster)\s*=\s*(['"])((?:\.{1,2}\/|\/(?!\/))[^'"]+)\1/gi)) found.push(match[2]);
  if (typeof image === 'string' && /^(?:\.{1,2}\/|\/(?!\/))/.test(image)) found.push(image);
  return [...new Set(found)].filter((x) => !remote.test(x));
}

async function safeAsset(post, ref, sourceRoot) {
  const decoded = decodeURIComponent(ref.split(/[?#]/, 1)[0]);
  const assetRoot = ref.startsWith('/') ? path.join(sourceRoot, 'public') : sourceRoot;
  const file = ref.startsWith('/') ? path.join(assetRoot, decoded.slice(1)) : path.resolve(path.dirname(post), decoded);
  const resolved = await realpath(file);
  const root = await realpath(assetRoot);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) throw new Error(`asset escapes source root: ${ref}`);
  if (!(await stat(resolved)).isFile()) throw new Error(`asset is not a file: ${ref}`);
  return resolved;
}

export async function prepare(sourceRoot) {
  const postsRoot = path.join(sourceRoot, 'src/content/posts');
  const posts = [];
  const ids = new Set();
  const issues = [];
  const warnings = [];
  for (const file of await walk(postsRoot)) {
    const rawSource = await readFile(file, 'utf8');
    const parsed = matter(rawSource);
    const metadata = JSON.parse(JSON.stringify(parsed.data));
    if (Object.hasOwn(metadata, '_mizukiMigration')) throw new Error(`reserved migration metadata key is already present: ${file}`);
    const slug = astroSlug(path.relative(postsRoot, file), metadata);
    if (!slug || ids.has(slug)) throw new Error(`duplicate or empty slug: ${slug}`);
    if (typeof metadata.title !== 'string' || !metadata.published) throw new Error(`post is missing title or published date: ${file}`);
    ids.add(slug);
    const assets = new Map();
    const isMdx = /\.mdx$/i.test(file);
    if (isMdx) {
      if (metadata.draft !== true) issues.push(`published MDX requires manual conversion: ${path.relative(sourceRoot, file)}`);
      else {
        // Preserve the entire original file as a private draft until MDX can be migrated.
        metadata.migration = { format: 'mdx', source: rawSource, requiresManualConversion: true };
        warnings.push(`MDX kept unpublished for manual conversion: ${path.relative(sourceRoot, file)}`);
      }
    }
    for (const ref of localReferences(parsed.content, metadata.image)) {
      if (isMdx && metadata.draft === true) {
        warnings.push(`MDX reference left unchanged for review: ${path.relative(sourceRoot, file)}: ${ref}`);
        continue;
      }
      try { assets.set(ref, await safeAsset(file, ref, sourceRoot)); }
      catch (error) {
        const message = `unresolved asset in ${path.relative(sourceRoot, file)}: ${ref}`;
        // Existing published root URLs are retained verbatim and reported for review.
        if (ref.startsWith('/')) warnings.push(message); else issues.push(message);
      }
    }
    if (assets.size && (metadata.draft === true || metadata.encrypted === true || (metadata.password != null && String(metadata.password).trim()))) {
      issues.push(`private or protected post has local media that cannot be placed in public uploads: ${path.relative(sourceRoot, file)}`);
    }
    const hash = createHash('sha256').update(rawSource);
    for (const [ref, asset] of [...assets].sort(([a], [b]) => a.localeCompare(b))) {
      hash.update(ref).update(await readFile(asset));
    }
    metadata._mizukiMigration = { sha256: hash.digest('hex') };
    posts.push({ slug, body: parsed.content, metadata, assets });
  }
  return { posts, issues, warnings };
}

function config() {
  const base = process.env.STRAPI_URL;
  const token = process.env.STRAPI_IMPORT_TOKEN;
  const publicUrl = process.env.STRAPI_PUBLIC_URL;
  if (!base || !token || !publicUrl) throw new Error('STRAPI_URL, STRAPI_IMPORT_TOKEN and STRAPI_PUBLIC_URL are required with --apply');
  const url = new URL(base);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('STRAPI_URL must be HTTP(S)');
  const publicOrigin = new URL(publicUrl);
  const host = publicOrigin.hostname.toLowerCase();
  if (publicOrigin.protocol !== 'https:' || publicOrigin.username || publicOrigin.password || publicOrigin.pathname !== '/' || publicOrigin.search || publicOrigin.hash || host === 'localhost' || host.endsWith('.local') || host.endsWith('.svc') || !host.includes('.') || /^(?:10\.|127\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)/.test(host) || host.startsWith('[')) {
    throw new Error('STRAPI_PUBLIC_URL must be a public HTTPS origin without path or credentials');
  }
  return { base: url.href.replace(/\/$/, ''), token, publicOrigin: publicOrigin.origin };
}

async function request(cfg, pathname, init = {}) {
  const response = await fetch(`${cfg.base}${pathname}`, {
    ...init, headers: { ...init.headers, Authorization: `Bearer ${cfg.token}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Strapi ${init.method || 'GET'} ${pathname.split('?')[0]} failed: HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}

async function existing(cfg, slug, status) {
  const query = new URLSearchParams({ 'filters[slug][$eq]': slug, status, 'pagination[pageSize]': '2' });
  const data = await request(cfg, `/api/posts?${query}`);
  if (!Array.isArray(data?.data)) throw new Error('invalid Strapi posts response');
  return data.data;
}

async function upload(cfg, file) {
  const data = new FormData();
  const bytes = await readFile(file);
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' }[path.extname(file).toLowerCase()] || 'application/octet-stream';
  data.append('files', new Blob([bytes], { type: mime }), path.basename(file));
  const result = await request(cfg, '/api/upload', { method: 'POST', body: data });
  if (!Array.isArray(result) || typeof result[0]?.url !== 'string') throw new Error('invalid Strapi upload response');
  const uploadPath = result[0].url;
  if (!uploadPath.startsWith('/uploads/') || uploadPath.startsWith('//')) throw new Error('Strapi returned an unsafe upload path');
  const publicUrl = new URL(uploadPath, cfg.publicOrigin);
  if (publicUrl.origin !== cfg.publicOrigin || !publicUrl.pathname.startsWith('/uploads/')) throw new Error('Strapi returned an unsafe upload path');
  return publicUrl.href;
}

export async function apply(posts, cfg) {
  // Check all entries before uploading. Resume only records with identical source+asset hashes.
  const skipped = new Set();
  for (const post of posts) {
    const matches = [...await existing(cfg, post.slug, 'draft'), ...await existing(cfg, post.slug, 'published')];
    if (matches.length) {
      const sameDoc = new Set(matches.map((entry) => entry.documentId));
      if (sameDoc.size !== 1 || matches.some((entry) => entry.metadata?._mizukiMigration?.sha256 !== post.metadata._mizukiMigration.sha256 || (post.assets.size && entry.metadata?._mizukiMigration?.mediaOrigin !== cfg.publicOrigin))) {
        throw new Error(`post already exists with different content; no entries were imported: ${post.slug}`);
      }
      skipped.add(post.slug);
    }
  }
  const uploads = new Map();
  let count = 0;
  for (const post of posts) {
    if (skipped.has(post.slug)) continue;
    let body = post.body;
    const metadata = { ...post.metadata, _mizukiMigration: { ...post.metadata._mizukiMigration, ...(post.assets.size ? { mediaOrigin: cfg.publicOrigin } : {}) } };
    const mediaPaths = new Set();
    for (const [ref, file] of post.assets) {
      if (!uploads.has(file)) uploads.set(file, await upload(cfg, file));
      const url = uploads.get(file);
      mediaPaths.add(new URL(url).pathname);
      // Replace only media references, preserving the author's alt text and attributes.
      body = body.replace(/(!\[[^\]\n]*\]\()((?:\.{1,2}\/|\/(?!\/))[^\s)]+)(?=[\s)])/g,
        (match, prefix, value) => value === ref ? `${prefix}${url}` : match);
      body = body.replace(/<(?:img|audio|video|source)\b[^>]*>/gi, (tag) =>
        tag.replace(/(\s(?:src|poster)\s*=\s*)(['"])([^'"]*)\2/gi,
          (match, prefix, quote, value) => value === ref ? `${prefix}${quote}${url}${quote}` : match));
      if (metadata.image === ref) metadata.image = url;
    }
    metadata._mizukiMigration.mediaPaths = [...mediaPaths].sort();
    const status = metadata.draft === true ? 'draft' : 'published';
    await request(cfg, `/api/posts?status=${status}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { slug: post.slug, body, metadata } }),
    });
    count++;
  }
  return { posts: count, skipped: skipped.size, uploadedAssets: uploads.size };
}

async function main(args) {
  const index = args.indexOf('--source');
  if (index < 0 || !args[index + 1] || args.some((x) => !['--source', args[index + 1], '--apply'].includes(x))) {
    throw new Error('usage: node scripts/import-mizuki.mjs --source /path/to/mizuki [--apply]');
  }
  const { posts, issues, warnings } = await prepare(path.resolve(args[index + 1]));
  const assets = new Set(posts.flatMap((post) => [...post.assets.values()]));
  if (!args.includes('--apply')) {
    console.log(JSON.stringify({ mode: 'dry-run', posts: posts.length, drafts: posts.filter((p) => p.metadata.draft === true).length, assets: assets.size, issues, warnings }));
    if (issues.length) process.exitCode = 2;
    return;
  }
  if (issues.length) throw new Error(`import blocked by ${issues.length} unresolved source issue(s); run dry-run for details`);
  console.log(JSON.stringify({ mode: 'import', ...await apply(posts, config()), warnings }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(`import failed: ${error.message}`); process.exitCode = 1; });
}

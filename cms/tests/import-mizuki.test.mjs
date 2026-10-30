import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { astroSlug, prepare, apply } from '../scripts/import-mizuki.mjs';

test('imports frontmatter and media without overwriting existing entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mizuki-import-'));
  const postsRoot = join(root, 'src/content/posts/Blog');
  await mkdir(join(postsRoot, 'assets'), { recursive: true });
  await mkdir(join(root, 'public/img'), { recursive: true });
  await writeFile(join(postsRoot, 'assets', 'photo.png'), 'image bytes');
  await writeFile(join(root, 'public/img/root.png'), 'root image');
  await writeFile(join(postsRoot, 'Hello 中文.md'), '---\ntitle: Example\npublished: 2024-01-03\ndraft: false\nimage: ./assets/photo.png\ntags: [one]\n---\n![alt](./assets/photo.png) <img src="./assets/photo.png"> ![root](/img/root.png)');
  const oldFetch = globalThis.fetch;
  const requests = [];
  try {
    const { posts, issues } = await prepare(root);
    assert.deepEqual(issues, []);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].slug, astroSlug('Blog/Hello 中文.md', {}));
    assert.equal(posts[0].metadata.draft, false);
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init });
      if (init.method === 'POST' && String(url).endsWith('/api/upload')) return Response.json([{ url: '/uploads/photo.png' }]);
      if (init.method === 'POST') return Response.json({ data: {} });
      return Response.json({ data: [] });
    };
    assert.deepEqual(await apply(posts, { base: 'http://cms.internal', publicOrigin: 'https://cms.example', token: 'test' }), { posts: 1, skipped: 0, uploadedAssets: 2 });
    const create = requests.find((r) => r.url.includes('/api/posts?status='));
    assert.match(create.url, /status=published/);
    const data = JSON.parse(create.init.body).data;
    assert.equal(data.metadata.image, 'https://cms.example/uploads/photo.png');
    assert.match(data.body, /src="https:\/\/cms\.example\/uploads\/photo\.png"/);
    assert.match(data.body, /!\[root\]\(https:\/\/cms\.example\/uploads\/photo\.png\)/);
    assert.equal(data.metadata.title, 'Example');
    assert.deepEqual(data.metadata._mizukiMigration.mediaPaths, ['/uploads/photo.png']);
    globalThis.fetch = async () => Response.json({ data: [{ documentId: 'existing', metadata: { _mizukiMigration: { ...posts[0].metadata._mizukiMigration, mediaOrigin: 'https://cms.example' } } }] });
    assert.deepEqual(await apply(posts, { base: 'http://cms.internal', publicOrigin: 'https://cms.example', token: 'test' }), { posts: 0, skipped: 1, uploadedAssets: 0 });
    globalThis.fetch = async () => Response.json({ data: [{ documentId: 'existing', metadata: {} }] });
    await assert.rejects(apply(posts, { base: 'http://cms.internal', publicOrigin: 'https://cms.example', token: 'test' }), /already exists/);
  } finally {
    globalThis.fetch = oldFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('keeps draft MDX verbatim and reports its unresolved image reference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mizuki-import-'));
  const dir = join(root, 'src/content/posts');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'fixture.mdx'), '---\ntitle: Example\npublished: 2024-01-03\ndraft: true\n---\n![alt](./missing.png)');
  try {
    const { posts, issues, warnings } = await prepare(root);
    assert.equal(posts.length, 1);
    assert.deepEqual(issues, []);
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /MDX/);
    assert.match(warnings[1], /missing.png/);
    assert.equal(posts[0].metadata.migration.format, 'mdx');
    assert.match(posts[0].metadata.migration.source, /missing.png/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

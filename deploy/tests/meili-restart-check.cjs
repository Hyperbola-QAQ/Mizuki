'use strict';
// An opt-in, disposable real-Meilisearch test. No production credentials or data.
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
if (process.env.MEILI_DISPOSABLE !== 'yes' || !process.env.MEILI_TEST_IMAGE) throw new Error('disposable opt-in and image required');
const name = `shirone-meili-restart-${process.pid}`;
const master = 'synthetic-only-master-key-2026';
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let base;
const wait = async (fn) => {
  for (let i = 0; i < 150; i++) { try { const result = await fn(); if (result) return result; } catch {} await new Promise(r => setTimeout(r, 200)); }
  throw new Error('timed out waiting for disposable search service');
};
async function api(method, path, key, body) {
  const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(2000) });
  if (!res.ok) throw new Error(`search API returned ${res.status}`);
  return res.status === 204 ? null : res.json();
}
function start(port = '') {
  docker('run', '-d', '--name', name, '-p', `127.0.0.1:${port}:7700`, '-e', `MEILI_MASTER_KEY=${master}`, process.env.MEILI_TEST_IMAGE);
  const assigned = docker('port', name, '7700/tcp').split(':').pop();
  base = `http://127.0.0.1:${assigned}`;
  return assigned;
}
(async () => {
  let stopMonitor;
  try {
    const port = start();
    await wait(async () => (await fetch(base + '/health')).ok);
    const defs = [
      {uid:randomUUID(), actions:['search'], indexes:['posts']},
      {uid:randomUUID(), actions:['documents.*','indexes.*','settings.*'], indexes:['posts','posts_rebuild']},
      {uid:randomUUID(), actions:['tasks.get'], indexes:['*']},
    ];
    const values = [];
    for (const def of defs) values.push((await api('POST', '/keys', master, {...def, expiresAt:null})).key);
    Object.assign(process.env, {MEILI_URL:base, MEILI_MASTER_KEY:master, MEILI_SEARCH_UID:defs[0].uid, MEILI_WRITER_UID:defs[1].uid, MEILI_TASKS_UID:defs[2].uid, MEILI_SEARCH_KEY:values[0], MEILI_WRITER_KEY:values[1], MEILI_TASKS_KEY:values[2], MEILI_ADMIN_KEY:values[1]});
    const { reconcile } = require('../tools/meili-key-reconciler.cjs');
    const search = require('../../cms/src/search/meilisearch.js');
    const { startSearchRebuild } = require('../../cms/src/search-hooks.js');
    const post = {documentId:'example', slug:'example', publishedAt:'2026-01-01', body:'中文搜索恢复测试', metadata:{title:'恢复测试'}};
    const cms = {documents: () => ({findMany:async () => [post]}), log:{error(){}}};
    stopMonitor = startSearchRebuild(cms, search.rebuild, search.isReady, 200, 300000);
    const marker = async () => {
      const result = await api('POST', '/indexes/posts/search', values[0], {q:'', filter:'kind = readiness'});
      return result.hits?.[0]?.generation;
    };
    const first = await wait(marker);
    docker('rm', '-f', name);
    start(port); // Fresh container has an empty data directory and no API keys.
    await wait(async () => (await fetch(base + '/health')).ok);
    await reconcile();
    const second = await wait(async () => { const generation = await marker(); return generation && generation !== first && generation; });
    const result = await api('POST', '/indexes/posts/search', values[0], {q:'恢复测试', filter:'kind = post'});
    if (!second || result.hits?.[0]?.title !== '恢复测试') throw new Error('rebuilt index did not contain the published article');
    console.log('live CMS monitor recovered keys and rebuilt published search after complete Meilisearch data loss');
  } finally {
    stopMonitor?.();
    try { docker('rm', '-f', name); } catch {}
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });

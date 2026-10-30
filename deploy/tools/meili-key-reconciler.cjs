'use strict';
// Separate service: only this process receives master plus expected restricted keys.
// Never overwrite a mismatched UID, permission set, or key.
const crypto = require('node:crypto');
const endpoint = process.env.MEILI_URL?.replace(/\/$/, '');
const master = process.env.MEILI_MASTER_KEY;
const keys = [
  {uid: process.env.MEILI_SEARCH_UID, expected: process.env.MEILI_SEARCH_KEY, actions: ['search'], indexes: ['posts']},
  {uid: process.env.MEILI_WRITER_UID, expected: process.env.MEILI_WRITER_KEY, actions: ['documents.*', 'indexes.*', 'settings.*'], indexes: ['posts', 'posts_rebuild']},
  // Swap tasks have no index UID, so Meilisearch only reveals them to a key
  // with wildcard index access. This key cannot read or change documents.
  {uid: process.env.MEILI_TASKS_UID, expected: process.env.MEILI_TASKS_KEY, actions: ['tasks.get'], indexes: ['*']},
];
function equal(a, b) { const x = Buffer.from(a || ''), y = Buffer.from(b || ''); return x.length === y.length && crypto.timingSafeEqual(x, y); }
function sameSet(a, b) { return Array.isArray(a) && a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]); }
async function call(method, path, body) {
  const r = await fetch(endpoint + path, {method, headers: {authorization: `Bearer ${master}`, 'content-type': 'application/json'}, body: body && JSON.stringify(body), signal: AbortSignal.timeout(10000)});
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Meilisearch key API status ${r.status}`);
  return r.json();
}
async function reconcile() {
  if (!endpoint || !master || keys.some(k => !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(k.uid || '') || !k.expected) || new Set(keys.map(k => k.uid.toLowerCase())).size !== keys.length) throw new Error('missing or invalid key configuration');
  for (const k of keys) {
    let found = await call('GET', `/keys/${k.uid}`);
    if (!found) found = await call('POST', '/keys', {uid:k.uid, actions:k.actions, indexes:k.indexes, expiresAt:null});
    if (!found || found.uid !== k.uid || found.expiresAt !== null || !sameSet(found.actions,k.actions) || !sameSet(found.indexes,k.indexes) || !equal(found.key,k.expected)) throw new Error('key identity or permissions mismatch; operator review required');
  }
}
async function run() {
  for (;;) {
    try { await reconcile(); console.log('restricted search keys verified'); }
    catch (error) { console.error('restricted search keys unavailable:', error.message); }
    await new Promise(resolve => setTimeout(resolve, 10000));
  }
}
if (require.main === module) void run();
module.exports = {reconcile};

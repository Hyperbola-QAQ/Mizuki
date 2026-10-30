#!/usr/bin/env node
'use strict';
// Local port-forward only. The operator supplies a private, persistent state
// directory with admin.json (0600). Token issuance is deliberately fail-closed.
const fs = require('node:fs');
const path = require('node:path');

const state = process.argv[2];
const endpoint = process.argv[3];
if (!state || !endpoint || process.argv.length !== 4) throw new Error('usage: node scripts/bootstrap-local.cjs /protected/state http://127.0.0.1:1337');
const root = path.resolve(state);
const url = new URL(endpoint);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.protocol !== 'http:' || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error('CMS endpoint must be an HTTP loopback origin');
const base = url.origin;
function safeStat(file, directory) {
  const info = fs.lstatSync(file);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('Insecure state file or directory permissions');
}
function syncDir() { const fd = fs.openSync(root, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function writeNew(file, value) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, value); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDir();
}
async function request(route, { method = 'GET', token, data } = {}) {
  const response = await fetch(base + route, { method, redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) },
    ...(data ? { body: JSON.stringify(data) } : {}) });
  if (!response.ok) throw new Error(`CMS ${method} ${route.split('?')[0]} returned ${response.status}`);
  return response.status === 204 ? null : response.json();
}
async function main() {
  safeStat(root, true);
  const adminFile = path.join(root, 'admin.json'); safeStat(adminFile, false);
  let admin;
  try { admin = JSON.parse(fs.readFileSync(adminFile, 'utf8')); }
  catch { throw new Error('Cannot read protected administrator credential'); }
  if (!['email','password','firstname','lastname'].every((key) => typeof admin[key] === 'string' && admin[key].length)) throw new Error('admin.json is incomplete');
  const lock = path.join(root, '.bootstrap.lock');
  fs.mkdirSync(lock, { mode: 0o700 }); syncDir();
  try {
    const init = await request('/admin/init');
    if (init?.data?.hasAdmin === false) await request('/admin/register-admin', { method: 'POST', data: admin });
    else if (init?.data?.hasAdmin !== true) throw new Error('Cannot verify administrator state');
    const login = await request('/admin/login', { method: 'POST', data: { email: admin.email, password: admin.password } });
    const session = login?.data?.token || login?.data?.accessToken;
    const userId = login?.data?.user?.id;
    if (!session || !userId) throw new Error('Cannot verify administrator identity');
    const identity = path.join(root, 'identity.json');
    if (fs.existsSync(identity)) {
      safeStat(identity, false);
      const saved = JSON.parse(fs.readFileSync(identity, 'utf8'));
      if (saved.userId !== userId || saved.email !== admin.email) throw new Error('Administrator identity mismatch');
    } else writeNew(identity, JSON.stringify({ userId, email: admin.email }));

    const specs = [
      { name: 'shirone-published-reader', file: 'reader', lifespan: null, permissions: ['api::published-content.published-content.find'] },
      { name: 'shirone-migration-import', file: 'import', lifespan: 604800000, permissions: ['api::post.post.find','api::post.post.findOne','api::post.post.create','plugin::upload.content-api.upload'] },
    ];
    function permissionsMatch(actual, expected) {
      return Array.isArray(actual) && actual.length === expected.length &&
        [...actual].sort().every((action, index) => action === [...expected].sort()[index]);
    }
    async function verifyToken(spec, token) {
      await request(spec.file === 'reader' ? '/api/published-content/posts?pagination[pageSize]=1&status=draft' : '/api/posts?status=draft&pagination[pageSize]=1', { token });
      if (spec.file === 'reader') {
        const denied = await fetch(base + '/api/posts?status=draft', { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(10000) });
        if (denied.status !== 403) throw new Error('reader token can access unrestricted posts endpoint');
      }
    }
    for (const spec of specs) {
      const pending = path.join(root, `${spec.file}.pending`);
      const secret = path.join(root, `${spec.file}.token`);
      const receipt = path.join(root, `${spec.file}.json`);
      if (fs.existsSync(pending)) throw new Error(`${spec.file} token outcome uncertain; stop for manual recovery`);
      const list = (await request('/admin/api-tokens', { token: session }))?.data;
      if (!Array.isArray(list)) throw new Error('Cannot inspect API token list');
      const matches = list.filter((item) => item.name === spec.name);
      if (fs.existsSync(secret) || fs.existsSync(receipt)) {
        if (!fs.existsSync(secret) || !fs.existsSync(receipt)) throw new Error(`${spec.file} token state incomplete`);
        safeStat(secret, false); safeStat(receipt, false);
        const saved = JSON.parse(fs.readFileSync(receipt, 'utf8'));
        if (matches.length !== 1 || matches[0].id !== saved.id || matches[0].type !== 'custom') throw new Error(`${spec.file} token identity mismatch`);
        const detail = (await request(`/admin/api-tokens/${saved.id}`, { token: session }))?.data;
        if (detail?.id !== saved.id || !permissionsMatch(detail.permissions, spec.permissions)) throw new Error(`${spec.file} token permissions changed`);
        const token = fs.readFileSync(secret, 'utf8').trim();
        if (!token) throw new Error(`${spec.file} token missing`);
        await verifyToken(spec, token);
        continue;
      }
      if (matches.length) throw new Error(`${spec.file} token name exists without local receipt`);
      // The marker is fsynced before the non-idempotent request. An interrupted
      // request is never retried automatically: the server may have accepted it.
      writeNew(pending, 'outcome-unknown\n');
      const result = await request('/admin/api-tokens', { method: 'POST', token: session,
        data: { name: spec.name, type: 'custom', permissions: spec.permissions, lifespan: spec.lifespan } });
      if (!result?.data?.accessKey || !result.data.id || !permissionsMatch(result.data.permissions, spec.permissions)) throw new Error('Token creation receipt incomplete or permissions mismatch');
      writeNew(secret, `${result.data.accessKey}\n`);
      writeNew(receipt, JSON.stringify({ id: result.data.id, name: spec.name, permissions: spec.permissions, expiresAt: result.data.expiresAt }));
      await verifyToken(spec, result.data.accessKey);
      fs.unlinkSync(pending); syncDir();
    }
    console.log('CMS bootstrap complete; credentials remain in protected state files.');
  } finally { fs.rmdirSync(lock); syncDir(); }
}
main().catch((error) => { console.error(`CMS bootstrap stopped: ${error.message}`); process.exitCode = 1; });

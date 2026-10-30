'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');

async function run(script, ...args) {
  const child = spawn(process.execPath, [path.join(root, 'scripts', script), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  child.stdout.on('data', (chunk) => { text += chunk; });
  child.stderr.on('data', (chunk) => { text += chunk; });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  return { code, text };
}

test('admin credential generation is private, create-only and never printed', async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'bootstrap-unit-'));
  try {
    const one = await run('prepare-bootstrap.cjs', state);
    assert.equal(one.code, 0);
    const filename = path.join(state, 'admin.json');
    const bytes = await fs.readFile(filename, 'utf8');
    const credential = JSON.parse(bytes);
    assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
    assert.ok(credential.password.length >= 20);
    assert.ok(!one.text.includes(credential.password) && !one.text.includes(credential.email));
    const two = await run('prepare-bootstrap.cjs', state);
    assert.equal(two.code, 0);
    assert.equal(await fs.readFile(filename, 'utf8'), bytes);
    await fs.chmod(filename, 0o644);
    assert.notEqual((await run('prepare-bootstrap.cjs', state)).code, 0);
  } finally { await fs.rm(state, { recursive: true, force: true }); }
});

test('uncertain issuance halts without creating another token', async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'bootstrap-pending-'));
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/admin/init') return res.end(JSON.stringify({ data: { hasAdmin: true } }));
    if (req.url === '/admin/login') return res.end(JSON.stringify({ data: { token: 'fake', user: { id: 1 } } }));
    res.writeHead(500).end('{}');
  });
  try {
    await fs.writeFile(path.join(state, 'admin.json'), JSON.stringify({ firstname: 'A', lastname: 'B', email: 'test@example.invalid', password: 'secret' }), { mode: 0o600 });
    await fs.writeFile(path.join(state, 'reader.pending'), 'outcome-unknown', { mode: 0o600 });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const result = await run('bootstrap-local.cjs', state, `http://127.0.0.1:${server.address().port}`);
    assert.notEqual(result.code, 0);
    assert.match(result.text, /outcome uncertain/);
    assert.ok(!requests.some((entry) => entry === 'POST /admin/api-tokens'));
  } finally { server.close(); await fs.rm(state, { recursive: true, force: true }); }
});


test('malformed credential content is never included in failure output', async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'bootstrap-malformed-'));
  try {
    const secret = 'secret-must-not-appear-in-output';
    await fs.writeFile(path.join(state, 'admin.json'), `{"password":"${secret}",`, { mode: 0o600 });
    const prepared = await run('prepare-bootstrap.cjs', state);
    assert.notEqual(prepared.code, 0);
    assert.ok(!prepared.text.includes(secret));
    const boot = await run('bootstrap-local.cjs', state, 'http://127.0.0.1:13387');
    assert.notEqual(boot.code, 0);
    assert.ok(!boot.text.includes(secret));
  } finally { await fs.rm(state, { recursive: true, force: true }); }
});

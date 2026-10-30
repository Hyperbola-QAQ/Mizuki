#!/usr/bin/env node
'use strict';
// Generate the initial admin credential exactly once in an existing private directory.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');

function main() {
  const dir = process.argv[2];
  if (!dir || process.argv.length !== 3 || !path.isAbsolute(dir)) throw new Error('usage: node scripts/prepare-bootstrap.cjs /absolute/protected/state');
  const root = fs.realpathSync(dir);
  const info = fs.lstatSync(dir);
  if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('State directory must be owned by the caller and mode 0700');
  const repo = fs.realpathSync(path.resolve(__dirname, '../..'));
  const relative = path.relative(repo, root);
  if (!relative || (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) throw new Error('State directory must be outside the repository');
  const command = spawnSync('git', ['-C', repo, 'config', '--get', 'user.email'], { encoding: 'utf8' });
  const email = command.status === 0 ? command.stdout.trim() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Repository user.email is unavailable or invalid');
  const target = path.join(root, 'admin.json');
  if (fs.existsSync(target)) {
    const existing = fs.lstatSync(target);
    if (existing.isSymbolicLink() || !existing.isFile() || existing.uid !== process.getuid() || (existing.mode & 0o077)) throw new Error('Existing administrator credential is not protected');
    const data = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (data.email !== email || typeof data.password !== 'string' || data.password.length < 20) throw new Error('Existing administrator credential does not match current Git email');
    console.log('Protected administrator credential already exists; left unchanged.');
    return;
  }
  const admin = { firstname: 'Site', lastname: 'Administrator', email, password: `${randomBytes(32).toString('base64url')}aA1!` };
  const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(admin)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const parent = fs.openSync(root, 'r'); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  console.log('Protected administrator credential prepared.');
}
try { main(); } catch (error) { console.error(`Credential preparation stopped: ${error.message}`); process.exitCode = 1; }

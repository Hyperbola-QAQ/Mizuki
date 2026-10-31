import test from 'node:test';
import assert from 'node:assert/strict';
import { hasAdminMediaAccess } from '../src/uploads/admin-media.mjs';
const cookie = '__Host-shirone-admin-media=encrypted';
const request = (host, value = cookie) => new Request('https://strapi.hyperbola.cc/uploads/a.png', { headers: { host, cookie: value } });
test('only admin host and an unambiguous capability can request authorization', async () => {
  let calls = 0;
  const fetcher = async (url, init) => { calls++; assert.equal(url.searchParams.get('path'), '/uploads/a.png'); assert.equal(init.headers.cookie, cookie); return { status: 204 }; };
  assert.equal(await hasAdminMediaAccess(request('hyperbola.cc'), 'http://cms:1337', '/uploads/a.png', fetcher), false);
  assert.equal(await hasAdminMediaAccess(request('strapi.hyperbola.cc', `${cookie}; ${cookie}`), 'http://cms:1337', '/uploads/a.png', fetcher), false);
  assert.equal(await hasAdminMediaAccess(request('strapi.hyperbola.cc'), 'http://cms:1337', '/uploads/a.png', fetcher), true);
  assert.equal(calls, 1);
  assert.equal(await hasAdminMediaAccess(request('strapi.hyperbola.cc'), 'http://cms:1337', '/uploads/a.png', async () => ({ status: 404 })), false);
  assert.equal(await hasAdminMediaAccess(request('strapi.hyperbola.cc'), 'http://cms:1337', '/uploads/a.png', async () => { throw Error(); }), false);
});

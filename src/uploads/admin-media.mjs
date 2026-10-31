// Only the admin host receives this host-only, encrypted media capability.
const COOKIE = '__Host-shirone-admin-media';
export async function hasAdminMediaAccess(request, base, path, fetcher = fetch) {
  const host = request.headers.get('host')?.toLowerCase();
  if (host !== 'strapi.hyperbola.cc') return false;
  const header = request.headers.get('cookie');
  if (!header || header.length > 16384) return false;
  const entries = header.split(';').map((v) => v.trim()).filter((v) => v.startsWith(`${COOKIE}=`));
  if (entries.length !== 1 || !/^[A-Za-z0-9_-]{1,12000}$/.test(entries[0].slice(COOKIE.length + 1))) return false;
  try {
    const check = new URL('/admin/shirone-media/check', base);
    check.searchParams.set('path', path);
    const response = await fetcher(check, { headers: { cookie: entries[0] }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000) });
    return response.status === 204;
  } catch { return false; }
}

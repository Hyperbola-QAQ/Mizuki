const STATIC_PATHS = ['/', '/about/', '/ai-tools/', '/albums/', '/anime/', '/archive/', '/categories/', '/compass/', '/devices/', '/diary/', '/friends/', '/games/', '/moments/', '/projects/', '/series/', '/skills/', '/tags/', '/timeline/'];
const escapeXml = value => value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');

export function sitemapIndex(origin) {
  const target=new URL('/sitemap-0.xml',origin).href;
  return `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${escapeXml(target)}</loc></sitemap></sitemapindex>`;
}

export function sitemapDocument(origin, postPaths, seriesSlugs) {
  const base=new URL(origin);
  const paths=[...STATIC_PATHS,...postPaths,...seriesSlugs.map(slug=>`/series/${encodeURIComponent(slug)}/`)];
  const urls=new Set();
  for(const path of paths) {
    if(typeof path!=='string'||!path.startsWith('/')||path.startsWith('//')||path.includes('\\'))continue;
    const url=new URL(path,base);
    if(url.origin!==base.origin||url.search||url.hash)continue;
    urls.add(url.href);
  }
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${[...urls].map(url=>`<url><loc>${escapeXml(url)}</loc></url>`).join('')}</urlset>`;
}

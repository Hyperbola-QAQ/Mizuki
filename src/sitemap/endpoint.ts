import type { APIRoute } from 'astro';
import { sitemapDocument, sitemapIndex } from './build.mjs';
import { sitemapContent } from './content.mjs';

export const prerender = false;
export const GET: APIRoute = async ({ url }) => {
  const origin = import.meta.env.SITE || 'https://hyperbola.cc/';
  const headers = { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-store' };
  if (url.pathname.endsWith('/sitemap-index.xml')) return new Response(sitemapIndex(origin), { headers });
  try {
    const { postPaths, seriesSlugs } = await sitemapContent();
    return new Response(sitemapDocument(origin, postPaths, seriesSlugs), { headers });
  } catch {
    return new Response('Sitemap unavailable', { status: 503, headers });
  }
};

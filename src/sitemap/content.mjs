import { getSeriesCatalog, getSortedPostsList } from '@utils/content-utils';

export async function sitemapContent() {
  const [posts, series] = await Promise.all([getSortedPostsList(), getSeriesCatalog()]);
  return { postPaths: posts.map(post => post.url).filter(Boolean), seriesSlugs: [...series.keys()] };
}

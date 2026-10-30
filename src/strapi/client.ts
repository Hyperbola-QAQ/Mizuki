/** Server-only Strapi 5 REST client. Published content is always requested. */
export type CmsKind = "posts" | "series-items" | "moments";
export interface CmsDocument {
  documentId?: string;
  slug: string;
  body?: string | null;
  metadata?: Record<string, unknown> | null;
  updatedAt?: string;
}

export async function getPublishedDocuments(kind: CmsKind): Promise<CmsDocument[]> {
  const base = process.env.STRAPI_URL;
  if (!base) throw new Error("STRAPI_URL is required to read published content");
  const endpoint = new URL(`/api/${kind}`, base);
  endpoint.searchParams.set("status", "published");
  endpoint.searchParams.set("pagination[pageSize]", "100");
  endpoint.searchParams.set("sort[0]", "slug:asc");
  const entries: CmsDocument[] = [];
  for (let page = 1; ; page++) {
    endpoint.searchParams.set("pagination[page]", String(page));
    const token = process.env.STRAPI_API_TOKEN;
    const response = await fetch(endpoint, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Strapi ${kind} request failed (${response.status})`);
    const payload = await response.json();
    if (!Array.isArray(payload?.data) || !payload?.meta?.pagination) {
      throw new Error(`Strapi ${kind} returned an invalid paginated response`);
    }
    for (const doc of payload.data) {
      if (!doc || typeof doc.slug !== "string" || !doc.slug) {
        throw new Error(`Strapi ${kind} returned a document without a slug`);
      }
      entries.push(doc);
    }
    const { pageCount } = payload.meta.pagination;
    if (!Number.isInteger(pageCount) || pageCount < 0) throw new Error(`Invalid ${kind} pagination`);
    if (page >= pageCount) return entries;
    if (page >= 10000) throw new Error(`Strapi ${kind} pagination exceeded the safety limit`);
  }
}

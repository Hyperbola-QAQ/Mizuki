import { AsyncLocalStorage } from "node:async_hooks";

/** Server-only Strapi 5 REST client. Published content is always requested. */
export type CmsKind = "posts" | "series-items" | "moments";
export interface CmsDocument {
  documentId?: string;
  slug: string;
  body?: string | null;
  metadata?: Record<string, unknown> | null;
  updatedAt?: string;
  rendered?: { html?: unknown; metadata?: unknown; sourceHash?: unknown; version?: unknown } | null;
}

// A fresh map is installed for each Astro request. Never reuse published
// data across requests: edits and withdrawals must be visible immediately.
const requestCache = new AsyncLocalStorage<Map<CmsKind, Promise<CmsDocument[]>>>();
export function withCmsRequestScope<T>(callback: () => Promise<T>): Promise<T> {
  return requestCache.run(new Map(), callback);
}
export function getPublishedDocuments(kind: CmsKind): Promise<CmsDocument[]> {
  const cache = requestCache.getStore();
  const existing = cache?.get(kind);
  if (existing) return existing;
  const result = fetchPublishedDocuments(kind);
  cache?.set(kind, result);
  return result;
}
async function fetchPublishedDocuments(kind: CmsKind): Promise<CmsDocument[]> {
  const base = process.env.STRAPI_URL;
  if (!base || !process.env.STRAPI_API_TOKEN) throw new Error("STRAPI_URL and STRAPI_API_TOKEN are required to read published content");
  const endpoint = new URL(`/api/published-content/${kind}`, base);
  endpoint.searchParams.set("pagination[pageSize]", "100");
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

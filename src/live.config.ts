import { defineLiveCollection } from "astro:content";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { z } from "astro/zod";
import { getPublishedDocuments, type CmsDocument, type CmsKind } from "./strapi/client";
import { contentSourceHash, renderContent } from "./strapi/render";

// LIVE_PROBE_FILE is intended only for the isolated integration test.
async function readDocuments(kind: CmsKind): Promise<CmsDocument[]> {
  if (process.env.LIVE_PROBE_FILE) {
    if (kind !== "posts") return [];
    const docs = JSON.parse(await readFile(process.env.LIVE_PROBE_FILE, "utf8"));
    return docs.map((doc: Record<string, unknown>) => ({
      slug: doc.slug,
      body: doc.body,
      metadata: { ...doc, slug: undefined, body: undefined },
    }));
  }
  return getPublishedDocuments(kind);
}

// Bound memory and share in-flight rendering across simultaneous page widgets.
const renderedCache = new Map<string, Promise<{code: string; metadata: Record<string, any>}>>();
const MAX_RENDERED_ENTRIES = 500;
const MAX_RENDER_CONCURRENCY = 4;
let runningRenderers = 0;
const renderWaiters: Array<() => void> = [];
async function withRenderPermit<T>(work: () => Promise<T>): Promise<T> {
  if (runningRenderers >= MAX_RENDER_CONCURRENCY) await new Promise<void>((resolve) => renderWaiters.push(resolve));
  else runningRenderers++;
  try { return await work(); } finally {
    const next = renderWaiters.shift();
    if (next) next(); else runningRenderers--;
  }
}
async function renderMarkdown(kind: CmsKind, doc: CmsDocument, body: string, data: Record<string, unknown>, snippets: CmsDocument[]) {
  const key = createHash("sha256").update(JSON.stringify([kind, doc.slug, doc.updatedAt, body, data, snippets])).digest("hex");
  const cached = renderedCache.get(key);
  if (cached) { renderedCache.delete(key); renderedCache.set(key, cached); return cached; }
  const work = withRenderPermit(async () => {
    const rendered = await renderContent(body, data, snippets);
    return { code: rendered.html, metadata: rendered.metadata };
  });
  renderedCache.set(key, work);
  while (renderedCache.size > MAX_RENDERED_ENTRIES) renderedCache.delete(renderedCache.keys().next().value!);
  try { return await work; } catch (error) { renderedCache.delete(key); throw error; }
}
// Never embed an internal CMS origin in public HTML. Strapi's own local
// uploads are exposed through the same-origin /uploads/ gateway route.
function publicMedia(value: unknown): unknown {
  if (typeof value === "string") {
    if (!process.env.STRAPI_URL) return value;
    const origin = new URL(process.env.STRAPI_URL).origin;
    return value.split(`${origin}/uploads/`).join("/uploads/");
  }
  if (Array.isArray(value)) return value.map(publicMedia);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, publicMedia(item)]));
  return value;
}

function asDates(metadata: Record<string, unknown>): Record<string, unknown> {
  const result = { ...metadata };
  for (const key of ["published", "publishedAt", "updated", "updatedAt"]) {
    if (typeof result[key] === "string") result[key] = new Date(result[key] as string);
  }
  return result;
}

function loader(kind: CmsKind) {
  async function entries() {
    const docs = await readDocuments(kind);
    const { postSchema, momentSchema, seriesSchema } = await import("shirones/collections");
    const schema = kind === "posts" ? postSchema : kind === "moments" ? momentSchema : seriesSchema;
    const ids = new Set<string>();
    return Promise.all(docs.map(async (doc) => {
      if (ids.has(doc.slug)) throw new Error(`Duplicate ${kind} slug: ${doc.slug}`);
      ids.add(doc.slug);
      const data = schema.parse(asDates(publicMedia(doc.metadata ?? {}) as Record<string, unknown>));
      if (kind === "posts" && "encrypted" in data && data.encrypted && !("password" in data && data.password && String(data.password).trim())) {
        throw new Error(`Encrypted post ${doc.slug} requires a password`);
      }
      const originalBody = doc.body ?? "";
      const body = publicMedia(originalBody) as string;
      const hasIncludes = body.includes('@include:');
      const snippets = hasIncludes ? await readDocuments('snippets') : [];
      // Only trust rendered snapshots tied to the exact stored source. Protected
      // documents never use stored HTML and stay in the server-only path.
      const snapshot = doc.rendered;
      const protectedPost = kind === "posts" && "password" in data && Boolean(data.password);
      const validSnapshot = !hasIncludes && !protectedPost && snapshot?.version === 1 && typeof snapshot.html === "string" && snapshot.metadata && typeof snapshot.metadata === "object" && snapshot.sourceHash === contentSourceHash(originalBody, doc.metadata ?? {});
      const rendered = validSnapshot
        ? { code: publicMedia(snapshot.html) as string, metadata: snapshot.metadata as Record<string, any> }
        : await renderMarkdown(kind, doc, body, data, snippets);
      return { id: doc.slug, data, body, rendered: {
        html: rendered.code,
        metadata: { ...rendered.metadata, frontmatter: rendered.metadata?.frontmatter ?? data },
      } };
    }));
  }
  return {
    name: `strapi-${kind}`,
    loadCollection: async () => ({ entries: await entries() }),
    loadEntry: async ({ filter }: { filter: { id: string } }) =>
      (await entries()).find((entry) => entry.id === filter.id),
  };
}

export const collections = {
  livePosts: defineLiveCollection({ loader: loader("posts"), schema: z.looseObject({}) }),
  liveSeries: defineLiveCollection({ loader: loader("series-items"), schema: z.looseObject({}) }),
  liveMoments: defineLiveCollection({ loader: loader("moments"), schema: z.looseObject({}) }),
};

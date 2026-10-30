import { defineLiveCollection } from "astro:content";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { z } from "astro:content";
import { getPublishedDocuments, type CmsDocument, type CmsKind } from "./strapi/client";

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

let rendererPromise: Promise<any> | undefined;
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
async function renderMarkdown(kind: CmsKind, doc: CmsDocument, body: string, data: Record<string, unknown>) {
  const key = createHash("sha256").update(JSON.stringify([kind, doc.slug, doc.updatedAt, body, data])).digest("hex");
  const cached = renderedCache.get(key);
  if (cached) { renderedCache.delete(key); renderedCache.set(key, cached); return cached; }
  rendererPromise ??= import("@utils/markdown-processor.mjs").then(({ siteMarkdownProcessor }) => siteMarkdownProcessor.createRenderer({}));
  // The markdown pipeline enriches its frontmatter object in place. Use a
  // separate copy and never pass a password into renderer metadata.
  const frontmatter = structuredClone(data);
  delete frontmatter.password;
  const work = withRenderPermit(async () => (await rendererPromise!).render(body, { frontmatter }));
  renderedCache.set(key, work);
  while (renderedCache.size > MAX_RENDERED_ENTRIES) renderedCache.delete(renderedCache.keys().next().value!);
  try { return await work; } catch (error) { renderedCache.delete(key); throw error; }
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
      const data = schema.parse(asDates(doc.metadata ?? {}));
      if (kind === "posts" && "encrypted" in data && data.encrypted && !("password" in data && data.password && String(data.password).trim())) {
        throw new Error(`Encrypted post ${doc.slug} requires a password`);
      }
      const body = doc.body ?? "";
      const rendered = await renderMarkdown(kind, doc, body, data);
      return { id: doc.slug, data, body, rendered: {
        html: rendered.code,
        metadata: { ...rendered.metadata, frontmatter: rendered.metadata?.frontmatter ?? data },
      } };
    }));
  }
  return {
    name: `strapi-${kind}`,
    loadCollection: async () => ({ entries: await entries() }),
    loadEntry: async ({ filter }: { filter: { id?: string } }) => ({
      entry: (await entries()).find((entry) => entry.id === filter.id),
    }),
  };
}

export const collections = {
  livePosts: defineLiveCollection({ loader: loader("posts"), schema: z.object({}).passthrough() }),
  liveSeries: defineLiveCollection({ loader: loader("series-items"), schema: z.object({}).passthrough() }),
  liveMoments: defineLiveCollection({ loader: loader("moments"), schema: z.object({}).passthrough() }),
};

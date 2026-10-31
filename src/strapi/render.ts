import { createHash } from "node:crypto";
import { getPublishedDocuments, type CmsDocument } from './client';
import { expandPublishedIncludes } from './includes.mjs';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}
export function contentSourceHash(body: string, metadata: Record<string, unknown>) {
  return createHash("sha256").update(JSON.stringify([body, canonical(metadata)])).digest("hex");
}

let rendererPromise: Promise<any> | undefined;
export async function renderContent(body: string, metadata: Record<string, unknown>, snippets?: CmsDocument[]) {
  // The Markdown pipeline mutates frontmatter; isolate it and omit credentials.
  const frontmatter = structuredClone(metadata);
  delete frontmatter.password;
  delete frontmatter.migration;
  rendererPromise ??= import("@utils/markdown-processor.mjs").then(({ runtimeMarkdownProcessor }) => runtimeMarkdownProcessor.createRenderer({}));
  const expanded = body.includes('@include:')
    ? expandPublishedIncludes(body, snippets ?? await getPublishedDocuments('snippets'))
    : body;
  const rendered = await (await rendererPromise).render(expanded, { frontmatter });
  return { html: rendered.code, metadata: rendered.metadata, sourceHash: contentSourceHash(body, metadata), version: 1 };
}

import type { APIRoute } from "astro";
import { getPublishedDocuments } from "../strapi/client";
import { uploadPath, publiclyReferences } from "./policy.mjs";
import { siteConfig } from "@/config";

export const prerender = false;
const missing = () => new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
export const GET: APIRoute = async ({ request }) => {
  const pathname = new URL(request.url).pathname;
  const path = uploadPath(pathname.slice("/uploads/".length));
  const base = process.env.STRAPI_URL;
  if (!path || !base) return missing();
  try {
    const origin = new URL(base).origin;
    const publicOrigin = new URL(siteConfig.site).origin;
    const groups = await Promise.all([getPublishedDocuments("posts"), getPublishedDocuments("series-items"), getPublishedDocuments("moments")]);
    if (!groups.some((docs) => docs.some((doc) => publiclyReferences(doc, path, [origin, publicOrigin])))) return missing();
    const response = await fetch(new URL(path, origin), { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10000) });
    if (!response.ok || !response.body) return missing();
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const headers = new Headers({
      "Content-Type": contentType,
      "Cache-Control": "no-store, private",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    });
    if (/^(?:text\/html|application\/xhtml\+xml)/i.test(contentType)) headers.set("Content-Disposition", "attachment");
    return new Response(response.body, { status: 200, headers });
  } catch { return missing(); }
};

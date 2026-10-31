import type { APIRoute } from "astro";
import { getPublishedDocuments } from "../strapi/client";
import { uploadPath, publiclyReferences, referencesMedia } from "./policy.mjs";
import { documentHasSession } from "./session.mjs";
import { siteConfig } from "@/config";
import { hasAdminMediaAccess } from "./admin-media.mjs";

export const prerender = false;
const missing = () => new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
const serve: APIRoute = async ({ request }) => {
  const pathname = new URL(request.url).pathname;
  const path = uploadPath(pathname.slice("/uploads/".length));
  const base = process.env.STRAPI_URL;
  if (!path || !base) return missing();
  try {
    const origin = new URL(base).origin;
    const publicOrigin = new URL(siteConfig.site).origin;
    const groups = await Promise.all([getPublishedDocuments("posts"), getPublishedDocuments("series-items"), getPublishedDocuments("moments")]);
    const origins = [origin, publicOrigin];
    const cookies = request.headers.get("cookie");
    const secret = process.env.PROTECTED_MEDIA_SESSION_SECRET;
    const adminAuthorized = await hasAdminMediaAccess(request, base, path);
    const authorized = adminAuthorized || groups.some((docs) => docs.some((doc) => publiclyReferences(doc, path, origins))) ||
      groups[0].some((doc) => documentHasSession(secret, cookies, doc) && referencesMedia(doc, path, origins));
    if (!authorized) return missing();
    const upstreamHeaders = new Headers();
    const range = request.headers.get("range");
    if (range && /^bytes=\d*-\d*$/.test(range) && range !== "bytes=-") upstreamHeaders.set("range", range);
    const ifRange = request.headers.get("if-range");
    if (range && ifRange) upstreamHeaders.set("if-range", ifRange);
    const response = await fetch(new URL(path, origin), { method: request.method === "HEAD" ? "HEAD" : "GET", headers: upstreamHeaders, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10000) });
    if (!response.ok && response.status !== 416) return missing();
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const headers = new Headers({
      "Content-Type": contentType,
      "Cache-Control": "no-store, private",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    });
    if (adminAuthorized) headers.set("Cross-Origin-Resource-Policy", "same-origin");
    if (/^(?:text\/html|application\/xhtml\+xml)/i.test(contentType)) headers.set("Content-Disposition", "attachment");
    for (const name of ["content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
      const value = response.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(request.method === "HEAD" || response.status === 416 ? null : response.body, { status: response.status, headers });
  } catch { return missing(); }
};

export const GET = serve;
export const HEAD = serve;

import type { APIRoute } from "astro";
import { siteConfig } from "@/config";
import { getPublishedDocuments } from "../strapi/client";
import { cookieName, createMediaToken, passwordMatches, sessionTtlSeconds, usableSecret } from "./session.mjs";

export const prerender = false;
const limit = 4096;
const failure = (status: number) => new Response(null, { status, headers: { "Cache-Control": "no-store" } });
let windowStart = 0;
let attempts = 0;
export const POST: APIRoute = async ({ request }) => {
  const secret = process.env.PROTECTED_MEDIA_SESSION_SECRET;
  if (!usableSecret(secret)) return failure(503);
  if (request.headers.get("origin") !== new URL(siteConfig.site).origin || !request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return failure(403);
  const now = Date.now();
  if (now - windowStart >= 60000) { windowStart = now; attempts = 0; }
  if (++attempts > 60) return failure(429);
  if (Number(request.headers.get("content-length") ?? 0) > limit || !request.body) return failure(413);
  try {
    const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > limit) { await reader.cancel(); return failure(413); } chunks.push(part.value); }
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value.slug !== "string" || value.slug.length > 512 || typeof value.password !== "string" || value.password.length > 1024) return failure(400);
    const docs = await getPublishedDocuments("posts");
    const doc = docs.find((item) => item.slug === value.slug && !item.metadata?.draft);
    const actual = doc?.metadata?.password;
    if (actual === undefined || !passwordMatches(secret, String(actual), value.password)) return failure(404);
    const token = createMediaToken(secret, value.slug, String(actual), Date.now(), `${doc?.documentId ?? ""}\0${doc?.updatedAt ?? ""}`);
    const secure = new URL(siteConfig.site).protocol === "https:" ? "; Secure" : "";
    return new Response(null, { status: 204, headers: {
      "Cache-Control": "no-store", "Set-Cookie": `${cookieName(value.slug)}=${token}; Path=/; Max-Age=${sessionTtlSeconds}; HttpOnly; SameSite=Lax${secure}`,
    } });
  } catch { return failure(404); }
};

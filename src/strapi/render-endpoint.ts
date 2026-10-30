import type { APIRoute } from "astro";
import { timingSafeEqual } from "node:crypto";
import { renderContent } from "./render";

export const prerender = false;
const LIMIT_BYTES = 1024 * 1024;
let active = 0;
const respond = (status: number) => new Response(null, { status, headers: { "Cache-Control": "no-store" } });

export const POST: APIRoute = async ({ request }) => {
  const expected = process.env.INTERNAL_RENDER_TOKEN;
  const given = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!expected || Buffer.byteLength(expected) !== Buffer.byteLength(given) || !timingSafeEqual(Buffer.from(expected), Buffer.from(given))) return respond(401);
  if (active >= 4) return respond(503);
  const size = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(size) || size > LIMIT_BYTES) return respond(413);
  if (!request.body) return respond(400);
  active++;
  try {
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > LIMIT_BYTES) { await reader.cancel(); return respond(413); }
      chunks.push(result.value);
    }
    let input: unknown;
    try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return respond(400); }
    if (!input || typeof input !== "object" || Array.isArray(input)) return respond(400);
    const { body, metadata } = input as { body?: unknown; metadata?: unknown };
    if (typeof body !== "string" || !metadata || typeof metadata !== "object" || Array.isArray(metadata)) return respond(400);
    const frontmatter = metadata as Record<string, unknown>;
    if (frontmatter.encrypted || (frontmatter.password !== undefined && String(frontmatter.password).trim())) return respond(400);
    const rendered = await renderContent(body, frontmatter);
    return Response.json(rendered, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return respond(500);
  } finally { active--; }
};

import { getPublishedDocuments } from "../strapi/client.ts";
import type { APIRoute } from "astro";

export const prerender = false;

// The browser never receives the Meilisearch or Strapi service token.
export const GET: APIRoute = async ({ url }) => {
  const q = (url.searchParams.get("q") || "").trim();
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (!q || q.length > 200) return new Response(JSON.stringify({ hits: [] }), { headers });
  const meiliUrl = process.env.MEILI_URL;
  const meiliKey = process.env.MEILI_SEARCH_KEY;
  const strapiUrl = process.env.STRAPI_URL;
  const strapiToken = process.env.STRAPI_API_TOKEN;
  const index = process.env.MEILI_INDEX || "posts";
  if (!meiliUrl || !meiliKey || !strapiUrl || !strapiToken || !/^[\w-]+$/.test(index)) return new Response(JSON.stringify({ error: "Search unavailable" }), { status: 503, headers });
  try {
    const response = await fetch(`${meiliUrl.replace(/\/$/, "")}/indexes/${index}/search`, {
      method: "POST", headers: { Authorization: `Bearer ${meiliKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ q, limit: 20, attributesToRetrieve: ["id", "url", "title", "description"] }), signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("Search failed");
    const data = await response.json();
    const hits = Array.isArray(data.hits) ? data.hits : [];
    // A failed or delayed index update must never expose a withdrawn article.
    // The CMS endpoint itself is published-only; do not grant the frontend
    // token access to the standard Strapi content API or draft status filters.
    const published = await getPublishedDocuments("posts");
    const byId = new Map(published.map((post) => [post.documentId, post]));
    const checked = hits.map((hit: Record<string, unknown>) => {
      if (typeof hit.id !== "string" || !/^[a-zA-Z0-9]+$/.test(hit.id)) return null;
      const post = byId.get(hit.id);
      const m = post?.metadata || {};
      if (!post || m.draft || m.encrypted || (m.password !== undefined && String(m.password).trim())) return null;
      const permalink = typeof m.permalink === "string" ? m.permalink.trim().replace(/^\/+|\/+$/g, "") : "";
      const alias = typeof m.alias === "string" ? m.alias.trim().replace(/^\/+|\/+$/g, "") : "";
      const path = permalink || `posts/${alias || post.slug || ""}`;
      if (path.split("/").some((part: string) => !part || part === "." || part === ".." || part.includes("\\"))) return null;
      const resultUrl = "/" + path.split("/").map(encodeURIComponent).join("/") + "/";
      return { url: resultUrl, title: String(m.title || post.slug || ""), description: String(m.description || "") };
    });
    return new Response(JSON.stringify({ hits: checked.filter(Boolean) }), { headers });
  } catch {
    return new Response(JSON.stringify({ error: "Search unavailable" }), { status: 503, headers });
  }
};

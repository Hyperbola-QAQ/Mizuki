import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

test("SSR reads all published Strapi pages and reflects edits and withdrawal", async () => {
  let docs = [
    { documentId: "a", slug: "first", body: "First content", metadata: { title: "First title", published: "2026-10-01", tags: ["demo"] }, updatedAt: "2026-10-01T00:00:00Z" },
    { documentId: "b", slug: "second", body: "Second content", metadata: { title: "Second title", published: "2026-10-02", tags: [] }, updatedAt: "2026-10-02T00:00:00Z" },
  ];
  let sawSecondPage = false;
  const cms = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.headers.authorization !== "Bearer test-server-token" || url.searchParams.get("status") !== "published") { res.writeHead(403).end(); return; }
    const page = Number(url.searchParams.get("pagination[page]"));
    if (url.pathname === "/api/posts") {
      sawSecondPage ||= page === 2;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: docs.slice(page - 1, page), meta: { pagination: { page, pageCount: docs.length } } }));
    } else if (["/api/series-items", "/api/moments"].includes(url.pathname)) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [], meta: { pagination: { page: 1, pageCount: 0 } } }));
    } else res.writeHead(404).end();
  });
  cms.listen(0, "127.0.0.1"); await once(cms, "listening");
  const port = 44000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, ["dist/server/entry.mjs"], {
    env: { ...process.env, LIVE_PROBE_FILE: "", STRAPI_URL: `http://127.0.0.1:${cms.address().port}`, STRAPI_API_TOKEN: "test-server-token", HOST: "127.0.0.1", PORT: String(port) }, stdio: "ignore",
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    let response;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error("Astro server exited before readiness");
      try { response = await fetch(base); break; } catch { await delay(100); }
    }
    assert.ok(response);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /First title/); assert.match(html, /Second title/); assert.ok(sawSecondPage);
    docs[0] = { ...docs[0], body: "Updated first content", metadata: { ...docs[0].metadata, title: "Updated first title" }, updatedAt: "2026-10-03T00:00:00Z" };
    response = await fetch(`${base}/posts/first/`); assert.equal(response.status, 200); assert.match(await response.text(), /Updated first content/);
    docs = docs.slice(1);
    response = await fetch(`${base}/posts/first/`); assert.equal(response.status, 404);
    response = await fetch(`${base}/archive/`); assert.equal(response.status, 200); const archive = await response.text(); const at = archive.indexOf("First title"); assert.equal(at, -1, at < 0 ? "" : archive.slice(at - 200, at + 200));
  } finally { child.kill(); cms.close(); await once(cms, "close"); }
});

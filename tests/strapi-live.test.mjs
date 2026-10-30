import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

test("SSR reads all published Strapi pages and reflects edits and withdrawal", async () => {
  let docs = [
    { documentId: "a", slug: "first", body: "First content", metadata: { title: "First title", published: "2026-10-01", tags: ["demo"] }, updatedAt: "2026-10-01T00:00:00Z" },
    { documentId: "b", slug: "second", body: "Second content", metadata: { title: "Second title", published: "2026-10-02", tags: [] }, updatedAt: "2026-10-02T00:00:00Z" },
  ];
  const includeDir = await mkdtemp(join(process.cwd(), ".include-security-"));
  const secretFile = join(includeDir, "secret.txt");
  await writeFile(secretFile, "UNIQUE_INCLUDE_FILE_SECRET_6447");
  let sawSecondPage = false;
  const cms = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/uploads/")) {
      const data = "PUBLIC_TEST_IMAGE";
      const range = req.headers.range;
      if (range === "bytes=0-5") {
        res.writeHead(206, { "content-type": "image/png", "content-range": `bytes 0-5/${data.length}`, "content-length": "6", "accept-ranges": "bytes" });
        res.end(req.method === "HEAD" ? undefined : data.slice(0, 6));
      } else { res.writeHead(200, { "content-type": "image/png", "content-length": String(data.length), "accept-ranges": "bytes" }); res.end(req.method === "HEAD" ? undefined : data); }
      return;
    }
    if (req.headers.authorization !== "Bearer test-server-token") { res.writeHead(403).end(); return; }
    const page = Number(url.searchParams.get("pagination[page]"));
    if (url.pathname === "/api/published-content/posts") {
      sawSecondPage ||= page === 2;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: docs.slice(page - 1, page), meta: { pagination: { page, pageCount: docs.length } } }));
    } else if (["/api/published-content/series-items", "/api/published-content/moments"].includes(url.pathname)) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [], meta: { pagination: { page: 1, pageCount: 0 } } }));
    } else res.writeHead(404).end();
  });
  cms.listen(0, "127.0.0.1"); await once(cms, "listening");
  const cmsOrigin = `http://127.0.0.1:${cms.address().port}`;
  docs[0].body += `\n\n![Media](${cmsOrigin}/uploads/media.png)`;
  docs[0].metadata.image = `https://hyperbola.cc/uploads/cover.png`;
  const port = 44000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, ["dist/server/entry.mjs"], {
    env: { ...process.env, LIVE_PROBE_FILE: "", STRAPI_URL: `http://127.0.0.1:${cms.address().port}`, STRAPI_API_TOKEN: "test-server-token", INTERNAL_RENDER_TOKEN: "test-internal-token", PROTECTED_MEDIA_SESSION_SECRET: "sufficiently-random-32-byte-test-secret", HOST: "127.0.0.1", PORT: String(port) }, stdio: "ignore",
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
    // Static pages retain a static document while their content-bearing sidebar
    // is a server island that reads the current CMS on every request.
    response = await fetch(`${base}/about/`); assert.equal(response.status, 200);
    const aboutHtml = await response.text();
    const matches = [...aboutHtml.matchAll(/href="([^"]*\/_server-islands\/SideBar\/[^"]*)"/g)];
    assert.ok(matches.length, "static about page exposes the deferred sidebar");
    const sidebarUrls = matches.map((match) => match[1].replaceAll("&amp;", "&"));
    const sidebarBefore = await Promise.all(sidebarUrls.map(async (url) => { const r = await fetch(base + url); assert.equal(r.status, 200); return r.text(); }));
    assert.match(sidebarBefore.join(""), /First title/);
    response = await fetch(`${base}/posts/first/`); const imageHtml = await response.text();
    assert.match(imageHtml, /\/uploads\/media\.png/); assert.match(imageHtml, /\/uploads\/cover\.png/); assert.ok(!imageHtml.includes(cmsOrigin), "internal CMS origin is not exposed");
    for (const path of ["/uploads/media.png", "/uploads/cover.png"]) {
      response = await fetch(base + path); assert.equal(response.status, 200, path);
      assert.match(response.headers.get("cache-control"), /no-store/); assert.equal(await response.text(), "PUBLIC_TEST_IMAGE");
    }
    response = await fetch(base + "/uploads/cover.png", { method: "HEAD" });
    assert.equal(response.status, 200); assert.equal(response.headers.get("content-length"), "17");
    response = await fetch(base + "/uploads/cover.png", { headers: { range: "bytes=0-5" } });
    assert.equal(response.status, 206); assert.equal(response.headers.get("content-range"), "bytes 0-5/17"); assert.equal(await response.text(), "PUBLIC");
    response = await fetch(base + "/uploads/unreferenced.png"); assert.equal(response.status, 404);
    const savedMetadata = docs[0].metadata;
    for (const restriction of [{ draft: true }, { encrypted: true, password: "secret" }, { password: "secret" }]) {
      docs[0].metadata = { ...savedMetadata, ...restriction };
      response = await fetch(base + "/uploads/cover.png"); assert.equal(response.status, 404, "restricted content does not expose media");
    }
    docs[0].metadata = savedMetadata;
    for (const path of ["/uploads/%252e%252e/cover.png", "/uploads/%2e%2e/cover.png", "/uploads/.env"]) {
      response = await fetch(base + path); assert.equal(response.status, 404, `reject ${path}`);
    }
    const renderRequest = { body: docs[0].body, metadata: docs[0].metadata };
    response = await fetch(`${base}/api/internal/render/`, { method: "POST", body: JSON.stringify(renderRequest) });
    assert.equal(response.status, 401, "render endpoint rejects anonymous requests");
    response = await fetch(`${base}/api/internal/render/`, { method: "POST", headers: { authorization: "Bearer test-internal-token" }, body: JSON.stringify({ ...renderRequest, metadata: { ...renderRequest.metadata, encrypted: true, password: "do-not-send" } }) });
    assert.equal(response.status, 400, "render endpoint rejects protected plaintext");
    response = await fetch(`${base}/api/internal/render/`, { method: "POST", headers: { authorization: "Bearer test-internal-token" }, body: JSON.stringify(renderRequest) });
    assert.equal(response.status, 200);
    const snapshot = await response.json(); assert.equal(snapshot.version, 1); assert.match(snapshot.html, /First content/);
    const reordered = { image: renderRequest.metadata.image, tags: renderRequest.metadata.tags, published: renderRequest.metadata.published, title: renderRequest.metadata.title };
    response = await fetch(`${base}/api/internal/render/`, { method: "POST", headers: { authorization: "Bearer test-internal-token" }, body: JSON.stringify({ body: renderRequest.body, metadata: reordered }) });
    assert.equal((await response.json()).sourceHash, snapshot.sourceHash, "object property order must not affect hashes");
    docs[0].metadata = reordered;
    docs[0].rendered = { ...snapshot, html: "<p>Stored snapshot marker</p>" };
    response = await fetch(`${base}/posts/first/`); assert.equal(response.status, 200); assert.match(await response.text(), /Stored snapshot marker/);
    const includes = `Updated first content\n\n<!-- @include: ${basename(includeDir)}/secret.txt -->\n<!-- @include: ${secretFile} -->\n<!-- @include: ../secret.txt -->`;
    response = await fetch(`${base}/api/internal/render/`, { method: "POST", headers: { authorization: "Bearer test-internal-token" }, body: JSON.stringify({ body: includes, metadata: renderRequest.metadata }) });
    assert.equal(response.status, 200); const safeRender = await response.json();
    assert.match(safeRender.html, /Updated first content/); assert.doesNotMatch(safeRender.html, /UNIQUE_INCLUDE_FILE_SECRET_6447/);
    docs[0] = { ...docs[0], body: includes, metadata: { ...docs[0].metadata, title: "Updated first title" }, updatedAt: "2026-10-03T00:00:00Z" };
    response = await fetch(`${base}/posts/first/`); assert.equal(response.status, 200); const updated = await response.text(); assert.match(updated, /Updated first content/); assert.doesNotMatch(updated, /UNIQUE_INCLUDE_FILE_SECRET_6447/);
    docs = docs.slice(1);
    response = await fetch(base + "/uploads/cover.png"); assert.equal(response.status, 404, "withdrawn media is unavailable");
    response = await fetch(`${base}/posts/first/`); assert.equal(response.status, 404);
    docs.push(
      { documentId: "p", slug: "secret-one", body: "![one](/uploads/private-one.png)", metadata: { title: "Secret one", published: "2026-10-01", password: "pass-one" } },
      { documentId: "q", slug: "secret-two", body: "![two](/uploads/private-two.png)", metadata: { title: "Secret two", published: "2026-10-01", password: "pass-two" } },
    );
    response = await fetch(base + "/uploads/private-one.png"); assert.equal(response.status, 404);
    const login = (slug, password, origin = "https://hyperbola.cc") => fetch(base + "/api/protected-media/session/", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ slug, password }) });
    response = await login("secret-one", "bad"); assert.equal(response.status, 404);
    response = await login("secret-one", "x".repeat(5000)); assert.equal(response.status, 413, "oversized password is rejected");
    response = await login("secret-one", "pass-one", "https://attacker.example"); assert.equal(response.status, 403);
    response = await login("secret-one", "pass-one"); assert.equal(response.status, 204);
    const firstCookie = response.headers.get("set-cookie");
    assert.match(firstCookie, /HttpOnly/); assert.match(firstCookie, /Secure/); assert.match(firstCookie, /SameSite=Lax/); assert.ok(!firstCookie.includes("pass-one"));
    const cookieOne = firstCookie.split(";")[0];
    response = await fetch(base + "/uploads/private-one.png", { headers: { cookie: cookieOne } }); assert.equal(response.status, 200);
    const [permitted, denied] = await Promise.all([
      fetch(base + "/uploads/private-one.png", { headers: { cookie: cookieOne } }),
      fetch(base + "/uploads/private-one.png"),
    ]);
    assert.equal(permitted.status, 200); assert.equal(denied.status, 404, "concurrent requests never share authorization");
    response = await fetch(base + "/uploads/private-two.png", { headers: { cookie: cookieOne } }); assert.equal(response.status, 404);
    response = await login("secret-two", "pass-two"); assert.equal(response.status, 204);
    const cookieTwo = response.headers.get("set-cookie").split(";")[0];
    response = await fetch(base + "/uploads/private-two.png", { headers: { cookie: `${cookieOne}; ${cookieTwo}` } }); assert.equal(response.status, 200);
    docs.find((doc) => doc.slug === "secret-one").metadata.password = "changed";
    response = await fetch(base + "/uploads/private-one.png", { headers: { cookie: cookieOne } }); assert.equal(response.status, 404, "password change invalidates the session immediately");
    docs = docs.filter((doc) => doc.slug !== "secret-two");
    response = await fetch(base + "/uploads/private-two.png", { headers: { cookie: cookieTwo } }); assert.equal(response.status, 404, "withdrawal invalidates the session immediately");
    const sidebarAfter = await Promise.all(sidebarUrls.map(async (url) => { const r = await fetch(base + url); assert.equal(r.status, 200); return r.text(); }));
    assert.doesNotMatch(sidebarAfter.join(""), /First title/);
    response = await fetch(`${base}/archive/`); assert.equal(response.status, 200); const archive = await response.text(); const at = archive.indexOf("First title"); assert.equal(at, -1, at < 0 ? "" : archive.slice(at - 200, at + 200));
  } finally { child.kill(); cms.close(); await once(cms, "close"); await rm(includeDir, { recursive: true, force: true }); }
});

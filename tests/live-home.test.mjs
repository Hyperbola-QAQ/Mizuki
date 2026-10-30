import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

// Run after `pnpm build`; a unique fixture avoids modifying real content.
test("the rendered homepage reflects changed live data without rebuilding", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shirone-live-test-"));
  const file = join(dir, "posts.json");
  const entries = JSON.parse(await readFile("live-data/posts.json", "utf8"));
  entries[0].title = "Live probe initial title";
  await writeFile(file, JSON.stringify(entries));
  const port = 44000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, ["dist/server/entry.mjs"], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), LIVE_PROBE_FILE: resolve(file) },
    stdio: "ignore",
  });
  try {
    let response;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error("Astro server exited before readiness");
      try { response = await fetch(`http://127.0.0.1:${port}/`); break; } catch { await delay(100); }
    }
    assert.ok(response, "server did not become ready");
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Live probe initial title/);
    entries[0].title = "Live probe updated title";
    await writeFile(file, JSON.stringify(entries));
    response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Live probe updated title/);
  } finally {
    child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("published routes update and protected content stays encrypted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shirone-routes-test-"));
  const file = join(dir, "posts.json");
  const entries = [
    { slug: "ordinary", title: "Runtime post", body: "Visible body before change", published: "2026-10-01", tags: ["runtime-tag"], category: "Runtime category", alias: "old-article", permalink: "custom-url" },
    { slug: "private", title: "Locked post", body: "UNIQUE_PRIVATE_ARTICLE_BODY_7744", description: "UNIQUE_PRIVATE_DESCRIPTION_7744", published: "2026-10-02", tags: [], encrypted: true, password: "UNIQUE_PASSWORD_7744", hideHomeContent: true },
  ];
  await writeFile(file, JSON.stringify(entries));
  const port = 44000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, ["dist/server/entry.mjs"], { env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), LIVE_PROBE_FILE: file }, stdio: "ignore" });
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error("Astro server exited before readiness");
      try { await fetch(base); break; } catch { await delay(100); }
    }
    for (const route of ["/", "/archive/", "/tags/", "/categories/", "/series/", "/moments/", "/posts/ordinary/", "/posts/old-article/", "/custom-url/", "/rss.xml", "/atom.xml"]) {
      const response = await fetch(base + route);
      assert.equal(response.status, 200, route);
      const text = await response.text();
      assert.doesNotMatch(text, /UNIQUE_PRIVATE_ARTICLE_BODY_7744|UNIQUE_PRIVATE_DESCRIPTION_7744|UNIQUE_PASSWORD_7744/, route);
      if (route === "/posts/ordinary/" || route === "/posts/old-article/" || route === "/custom-url/") assert.match(text, /Visible body before change/, route);
    }
    const protectedResponse = await fetch(base + "/posts/private/");
    assert.equal(protectedResponse.status, 200);
    const protectedHtml = await protectedResponse.text();
    assert.doesNotMatch(protectedHtml, /UNIQUE_PRIVATE_ARTICLE_BODY_7744|UNIQUE_PRIVATE_DESCRIPTION_7744|UNIQUE_PASSWORD_7744/);
    for (const route of ["/llms.txt", "/llms-full.txt", "/about/", "/404/"]) {
      const response = await fetch(base + route);
      const body = await response.text();
      assert.doesNotMatch(body, /UNIQUE_PRIVATE_ARTICLE_BODY_7744|UNIQUE_PRIVATE_DESCRIPTION_7744|UNIQUE_PASSWORD_7744/, route);
    }
    entries[0].body = "Visible body after change";
    entries[0].title = "Updated runtime post";
    await writeFile(file, JSON.stringify(entries));
    for (const route of ["/", "/archive/", "/posts/ordinary/"]) {
      const response = await fetch(base + route);
      assert.equal(response.status, 200, route);
      assert.match(await response.text(), /Updated runtime post/, route);
    }
    entries[1].password = "";
    await writeFile(file, JSON.stringify(entries));
    const invalid = await fetch(base + "/posts/private/");
    assert.equal(invalid.status, 500, "encrypted post without password fails closed");
    assert.doesNotMatch(await invalid.text(), /UNIQUE_PRIVATE_ARTICLE_BODY_7744|UNIQUE_PRIVATE_DESCRIPTION_7744/);
  } finally { child.kill(); await rm(dir, { recursive: true, force: true }); }
});

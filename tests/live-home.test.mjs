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

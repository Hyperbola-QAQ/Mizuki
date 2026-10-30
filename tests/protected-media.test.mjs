import test from "node:test";
import assert from "node:assert/strict";
import { createMediaToken, verifyMediaToken, cookieName, documentHasSession } from "../src/uploads/session.mjs";

const secret = "sufficiently-random-32-byte-test-secret";
test("protected media session is signed, unpredictable, scoped and expires", () => {
  const now = 1_800_000_000_000;
  const a = createMediaToken(secret, "post-a", "password-a", now, "revision-one");
  const b = createMediaToken(secret, "post-a", "password-a", now, "revision-one");
  assert.notEqual(a, b);
  assert.ok(!a.includes("password-a"));
  assert.equal(verifyMediaToken(secret, a, "post-a", "password-a", now, "revision-one"), true);
  assert.equal(verifyMediaToken(secret, a, "post-b", "password-a", now, "revision-one"), false);
  assert.equal(verifyMediaToken(secret, a, "post-a", "changed", now, "revision-one"), false);
  assert.equal(verifyMediaToken(secret, a, "post-a", "password-a", now + 16 * 60 * 1000, "revision-one"), false);
  assert.equal(verifyMediaToken(secret, a + "x", "post-a", "password-a", now, "revision-one"), false);
  assert.equal(verifyMediaToken(secret, a, "post-a", "password-a", now, "revision-two"), false);
  const doc = { slug: "post-a", documentId: "id", updatedAt: "time", metadata: { password: "password-a" } };
  const bound = createMediaToken(secret, "post-a", "password-a", now, "id\0time");
  assert.equal(documentHasSession(secret, `${cookieName("post-a")}=${bound}`, doc, now), true);
  assert.equal(documentHasSession(secret, `${cookieName("post-b")}=${bound}`, doc, now), false);
  assert.equal(documentHasSession(secret, `${cookieName("post-a")}=${bound}`, { ...doc, metadata: { ...doc.metadata, draft: true } }, now), false);
});

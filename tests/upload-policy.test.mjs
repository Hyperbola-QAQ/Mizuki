import assert from "node:assert/strict";
import test from "node:test";
import { uploadPath, publiclyReferences } from "../src/uploads/policy.mjs";

test("upload authorization only accepts exact public media references", () => {
  const origin = "http://strapi.internal:1337";
  const target = "/uploads/image_abc.png";
  assert.equal(uploadPath("image_abc.png"), target);
  for (const value of ["../private.png", "%2e%2e/private.png", "a/../private.png", ".env", "image.png%2fsecret", "file.html"]) assert.equal(uploadPath(value), null);
  const doc = { body: `![image](${target})`, metadata: {} };
  assert.equal(publiclyReferences(doc, target, origin), true);
  assert.equal(publiclyReferences({ body: `![image](${target}x)`, metadata: {} }, target, origin), false);
  assert.equal(publiclyReferences({ body: "", metadata: { _mizukiMigration: { mediaPaths: [target] } } }, target, origin), false);
  for (const metadata of [{ draft: true }, { encrypted: true }, { password: "secret" }]) assert.equal(publiclyReferences({ ...doc, metadata }, target, origin), false);
  assert.equal(publiclyReferences({ body: "", metadata: { image: `${origin}${target}` } }, target, origin), true);
  assert.equal(publiclyReferences({ body: `![image](https://hyperbola.cc${target})`, metadata: {} }, target, [origin, "https://hyperbola.cc"]), true);
  assert.equal(publiclyReferences({ body: `![image](https://attacker.example${target})`, metadata: {} }, target, [origin, "https://hyperbola.cc"]), false);
  assert.equal(publiclyReferences({ body: `<img src="${target}">`, metadata: {} }, target, origin), true);
});

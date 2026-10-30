import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { getPublishedDocuments, withCmsRequestScope } from "../src/strapi/client.ts";

test("CMS fetches are shared only inside one request scope", async () => {
  let calls = 0;
  let title = "first";
  const server = createServer((_req, res) => {
    calls++;
    const data = [{ slug: "post", metadata: { title } }];
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data, meta: { pagination: { pageCount: 1 } } }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const previous = process.env.STRAPI_URL;
  process.env.STRAPI_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    const results = await Promise.all([0, 1].map(() => withCmsRequestScope(async () => {
      const [a, b] = await Promise.all([getPublishedDocuments("posts"), getPublishedDocuments("posts")]);
      assert.equal(a, b);
      return a;
    })));
    assert.equal(calls, 2, "parallel requests must not share their cache");
    assert.notEqual(results[0], results[1]);
    title = "changed";
    const next = await withCmsRequestScope(() => getPublishedDocuments("posts"));
    assert.equal(calls, 3);
    assert.equal(next[0].metadata.title, "changed");
  } finally {
    if (previous === undefined) delete process.env.STRAPI_URL; else process.env.STRAPI_URL = previous;
    server.close(); await once(server, "close");
  }
});

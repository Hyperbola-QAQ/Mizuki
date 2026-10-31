import test from 'node:test';
import assert from 'node:assert/strict';
import { sitemapDocument, sitemapIndex } from '../src/sitemap/build.mjs';

test('sitemap reflects supplied published paths without accepting external URLs', () => {
  const origin='https://hyperbola.cc/';
  const first=sitemapDocument(origin,['/posts/中文/','//evil.example/post','/posts/中文/'],['系列']);
  assert.match(first, /posts\/%E4%B8%AD%E6%96%87/);
  assert.match(first, /series\/%E7%B3%BB%E5%88%97/);
  assert.doesNotMatch(first, /evil\.example/);
  const next=sitemapDocument(origin,['/posts/changed/'],[]);
  assert.match(next,/posts\/changed/);
  assert.doesNotMatch(next,/%E4%B8%AD%E6%96%87/);
  assert.match(sitemapIndex(origin),/https:\/\/hyperbola\.cc\/sitemap-0\.xml/);
});

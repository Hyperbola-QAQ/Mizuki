import test from 'node:test';
import assert from 'node:assert/strict';
import {expandPublishedIncludes} from '../src/strapi/includes.mjs';
test('published snippets support whole files, line ranges, regions and nested relative paths',()=>{
  const snippets=[{slug:'snippets/a.md',body:'before\n<!-- #region part -->\nvisible\n<!-- #endregion part -->\nafter\n<!-- @include: nested/b.md -->'},{slug:'snippets/nested/b.md',body:'nested'}];
  assert.match(expandPublishedIncludes('<!-- @include: snippets/a.md#part -->',snippets),/^visible$/);
  assert.match(expandPublishedIncludes('<!-- @include: snippets/a.md{1-2} -->',snippets),/^before\n<!-- #region part -->$/);
  assert.match(expandPublishedIncludes('<!-- @include: snippets/a.md -->',snippets),/nested/);
});
test('unknown files, traversal, cyclic references and fenced examples remain inert',()=>{
  const snippets=[{slug:'a.md',body:'<!-- @include: a.md -->'}];
  const input='<!-- @include: ../../etc/passwd -->\n<!-- @include: /etc/passwd -->\n```md\n<!-- @include: a.md -->\n```';
  assert.equal(expandPublishedIncludes(input,snippets),input);
  assert.equal(expandPublishedIncludes('<!-- @include: a.md -->',snippets),'<!-- @include: a.md -->');
  assert.throws(()=>expandPublishedIncludes('<!-- @include: a.md -->',[...snippets,...snippets]),/Duplicate published snippet slug/);
});

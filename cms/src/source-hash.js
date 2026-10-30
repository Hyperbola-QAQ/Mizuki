'use strict';
const { createHash } = require('node:crypto');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function sourceHash(body, metadata) {
  return createHash('sha256').update(JSON.stringify([body, canonical(metadata)])).digest('hex');
}
module.exports = { sourceHash };

'use strict';
const { listPublished } = require('../../../published-content');
module.exports = {
  async find(ctx) {
    let result;
    try { result = await listPublished(strapi, ctx.params.kind, ctx.query); }
    catch (error) {
      if (error.message === 'Invalid pagination') return ctx.badRequest('Invalid pagination');
      throw error;
    }
    if (!result) return ctx.notFound();
    ctx.set('Cache-Control', 'private, no-store');
    ctx.body = result;
  },
};

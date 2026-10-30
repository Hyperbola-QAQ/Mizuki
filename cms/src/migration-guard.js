'use strict';

const { ValidationError } = require('@strapi/utils').errors;
const POST_UID = 'api::post.post';

/** MDX retained from the old site is not safe to render as Markdown. */
function registerMigrationGuard(strapi) {
  strapi.documents.use(async (context, next) => {
    if (context.uid !== POST_UID) return next();
    const params = context.params || {};
    const publishes = context.action === 'publish' ||
      (['create', 'update'].includes(context.action) && params.status === 'published');
    if (!publishes) return next();
    let metadata = params.data?.metadata;
    if (!metadata && params.documentId) {
      const draft = await strapi.documents(POST_UID).findOne({ documentId: params.documentId, status: 'draft' });
      if (!draft) throw new ValidationError('Cannot verify the draft before publishing');
      metadata = draft.metadata;
    }
    if (metadata?.migration?.format === 'mdx' && metadata.migration.requiresManualConversion !== false) {
      throw new ValidationError('Imported MDX must be converted before it can be published');
    }
    return next();
  });
}

module.exports = { registerMigrationGuard };

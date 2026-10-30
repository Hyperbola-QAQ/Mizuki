'use strict';

const { registerSearchHooks, startSearchRebuild } = require('./search-hooks');
const { registerRenderHooks } = require('./render-hooks');
const { registerMigrationGuard } = require('./migration-guard');
const { reconcile, rebuild, isReady } = require('./search/meilisearch');
let stopSearchRebuild;

module.exports = {
  register({ strapi }) {
    registerMigrationGuard(strapi);
    registerRenderHooks(strapi);
    registerSearchHooks(strapi, reconcile);
  },
  bootstrap({ strapi }) {
    if (process.env.MEILI_URL && process.env.MEILI_ADMIN_KEY) {
      stopSearchRebuild = startSearchRebuild(strapi, rebuild, isReady);
    } else {
      strapi.log.warn('[search] Meilisearch is not configured; indexing is disabled');
    }
  },
  destroy() {
    stopSearchRebuild?.();
  },
};

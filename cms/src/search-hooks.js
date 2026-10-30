'use strict';

const POST_UID = 'api::post.post';
const MUTATIONS = new Set(['create', 'update', 'publish', 'unpublish', 'delete']);
let searchDirty = false;

/** Register once during the Strapi register lifecycle. */
function registerSearchHooks(strapi, reconcile) {
  strapi.documents.use(async (context, next) => {
    const result = await next();
    if (context.uid !== POST_UID || !MUTATIONS.has(context.action)) return result;
    const documentId = context.params?.documentId || result?.documentId;
    if (!documentId) {
      searchDirty = true;
      strapi.log.error('[search] mutation completed without a document ID; full reconciliation required');
      return result;
    }
    try {
      await reconcile(strapi, documentId);
    } catch (error) {
      // The content transaction has already completed. Do not report it as failed.
      searchDirty = true;
      strapi.log.error(`[search] reconciliation failed for ${documentId}; periodic rebuild will retry: ${error.message}`);
    }
    return result;
  });
}

function startSearchRebuild(strapi, rebuild, isReady, intervalMs = 5000, fullIntervalMs = 300000) {
  let running = false;
  let previouslyReady = false;
  let nextFull = 0;
  async function run() {
    if (running) return;
    running = true;
    try {
      const ready = await isReady();
      if (!ready || !previouslyReady || searchDirty || Date.now() >= nextFull) {
        await rebuild(strapi);
        searchDirty = false;
        nextFull = Date.now() + fullIntervalMs;
      }
      previouslyReady = true;
    } catch (error) {
      previouslyReady = false;
      strapi.log.error(`[search] readiness/rebuild failed: ${error.message}`);
    } finally { running = false; }
  }
  void run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { registerSearchHooks, startSearchRebuild };

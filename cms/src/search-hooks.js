'use strict';

const POST_UID = 'api::post.post';
const MUTATIONS = new Set(['create', 'update', 'publish', 'unpublish', 'delete']);

/** Register once during the Strapi register lifecycle. */
function registerSearchHooks(strapi, reconcile) {
  strapi.documents.use(async (context, next) => {
    const result = await next();
    if (context.uid !== POST_UID || !MUTATIONS.has(context.action)) return result;
    const documentId = context.params?.documentId || result?.documentId;
    if (!documentId) {
      strapi.log.error('[search] mutation completed without a document ID; full reconciliation required');
      return result;
    }
    try {
      await reconcile(strapi, documentId);
    } catch (error) {
      // The content transaction has already completed. Do not report it as failed.
      strapi.log.error(`[search] reconciliation failed for ${documentId}; periodic rebuild will retry: ${error.message}`);
    }
    return result;
  });
}

function startSearchRebuild(strapi, rebuild, intervalMs = 300000) {
  let running = false;
  async function run() {
    if (running) return;
    running = true;
    try { await rebuild(strapi); }
    catch (error) { strapi.log.error(`[search] periodic rebuild failed: ${error.message}`); }
    finally { running = false; }
  }
  // Reconcile after restart, then periodically repair missed updates and deletions.
  void run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { registerSearchHooks, startSearchRebuild };

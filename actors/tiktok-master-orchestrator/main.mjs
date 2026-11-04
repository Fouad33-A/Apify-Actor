import { Actor, log } from 'apify';
import { ACTOR_IDS, selectCreators, prepareCommentsInput, summarize } from './pipeline.mjs';
await Actor.init();
const input = (await Actor.getInput()) ?? {};
const childRuns = {};
let exitCode = 0;
async function runChild(name, actorId, childInput, timeoutSecs) {
  log.info('Starting ' + name + ' (' + actorId + ')');
  const run = await Actor.call(actorId, childInput, { waitSecs: timeoutSecs });
  if (run?.status !== 'SUCCEEDED' || !run.defaultDatasetId) throw new Error(name + ' failed: ' + (run?.status ?? 'unknown') + ' (run ' + (run?.id ?? 'unknown') + ')');
  childRuns[name] = {actorId, runId: run.id, datasetId: run.defaultDatasetId, status: run.status};
  const data = await Actor.apifyClient.dataset(run.defaultDatasetId).listItems({limit: 5000});
  if (data.total > 5000) throw new Error(name + ' output too large for safe handoff');
  return data.items;
}
try {
  const maxCreators = Math.max(1, Math.min(100, Math.floor(Number(input.maxCreators) || 5)));
  const maxCommentsPerPost = Math.max(1, Math.min(1000, Math.floor(Number(input.maxCommentsPerPost) || 100)));
  const timeoutSecs = Math.max(60, Math.min(3600, Math.floor(Number(input.childTimeoutSecs) || 900)));
  const searchRows = await runChild('creatorSearch', ACTOR_IDS.creatorSearch, {
    ...(input.searchInput ?? {}), maxCreators, onlyPassing: true, enrichProfiles: true, profileActor: ACTOR_IDS.profileStats,
  }, timeoutSecs);
  const creators = selectCreators(searchRows, maxCreators);
  if (!creators.length) throw new Error('No confirmed qualifying creators; stopping before downstream runs.');
  const profileRows = await runChild('profileStats', ACTOR_IDS.profileStats, {
    usernames: creators, mode: 'full', outputRows: 'summaryOnly', videosPerProfile: 10, maxItems: Math.max(200, creators.length * 2),
  }, timeoutSecs);
  const commentsInput = prepareCommentsInput(profileRows, maxCommentsPerPost);
  if (!commentsInput.creatorVideos.length) throw new Error('No creators with two usable videos; stopping before Comments run.');
  const commentRows = await runChild('comments', ACTOR_IDS.comments, commentsInput, timeoutSecs);
  const result = summarize({creators, commentsInput, commentRows, childRuns});
  await Actor.pushData(result);
  await Actor.setValue('OUTPUT', result);
} catch (error) {
  exitCode = 1;
  log.error(error.stack ?? error.message);
  const result = {recordType: 'PIPELINE_SUMMARY', status: 'failed', error: error.message, childRuns};
  await Actor.pushData(result);
  await Actor.setValue('OUTPUT', result);
} finally {
  await Actor.exit({exitCode});
}

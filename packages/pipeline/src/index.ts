/**
 * The prospecting pipeline and its background jobs.
 *
 * This lives in a package rather than an app because both the API (adding a
 * prospect on demand) and the server's background loop (scheduled work) run
 * the same chain. An app importing another app's source would make the
 * dependency direction a lie.
 */

export { runCrawlJob, type CrawlJobDeps, type CrawlJobResult } from './crawl';
export {
  runPipeline,
  runPipelineForCandidate,
  type CandidateOrigin,
  type PipelineOptions,
  type PipelineResult,
} from './pipeline';
export {
  expireSignals,
  markSourceUnavailable,
  processDeletion,
  rescoreProspect,
  JOB_KINDS,
  type JobKind,
  type JobResult,
} from './jobs';
export {
  batchStatus,
  claimNext,
  completeJob,
  drainQueue,
  enqueue,
  failJob,
  queueDepth,
  reclaimStalled,
  JOB_STATUSES,
  type BatchItem,
  type BatchStatus,
  type DrainSummary,
  type EnqueueInput,
  type EnqueueResult,
  type JobHandler,
  type JobStatus,
  type QueuedJob,
} from './queue';

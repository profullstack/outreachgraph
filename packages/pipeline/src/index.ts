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
  regenerateRecommendations,
  type RegenerateInput,
  type RegenerateResult,
} from './regenerate';
export { runDiscoveryJob, type DiscoveryJobDeps, type DiscoveryJobResult } from './discovery';
export {
  runAutopilot,
  type AutopilotDeps,
  type AutopilotResult,
  type SentOutreach,
  type SkippedOutreach,
} from './autopilot';
export {
  runListening,
  listeningCampaigns,
  campaignTerms,
  type ListenDeps,
  type ListenInput,
  type ListenResult,
} from './listen';
export {
  loadListeningTargets,
  saveListeningTargets,
  normaliseTargets,
  normaliseSubreddit,
  normaliseFeedUrl,
  LISTEN_SOURCE_SLUGS,
  NO_LISTENING,
  type ListeningTargets,
  type ListeningTargetsInput,
  type ListenSourceSlug,
} from './listening-targets';
export {
  connectEmailAccount,
  disconnectEmailAccount,
  emailAccountSummary,
  loadEmailCredentials,
  loadImapCredentials,
  mailerForWorkspace,
  EmailAccountError,
  type EmailAccountInput,
  type EmailAccountSummary,
} from './email-account';
export { runCadences, type RunCadencesDeps } from './cadence-runner';
export {
  createRule,
  runRules,
  setRuleEnabled,
  signalEvent,
  type CreateRuleInput,
  type RunRulesResult,
} from './rules';
export {
  budgetStatus,
  planFor,
  recordResearchUsage,
  usageFor,
  type BudgetStatus,
} from './metering';
export {
  creditsFor,
  grantCredits,
  organizationFor,
  settleProspectCredits,
  spendProspectCredit,
} from './credits';
export {
  createResearchGrid,
  runResearchGrid,
  readResearchGrid,
  MAX_GRID_CELLS,
  type CreateGridInput,
  type CreateGridResult,
  type GridRow,
  type RunGridDeps,
  type RunGridResult,
} from './research-grid';
export { expandCampaignTerms, EXPANSION_TTL_DAYS, type ExpandTermsDeps } from './term-expansion';
export {
  agentForWorkspace,
  blueskyAccountSummary,
  connectBlueskyAccount,
  disconnectBlueskyAccount,
  loadBlueskyCredentials,
  BlueskyAccountError,
  type BlueskyAccountSummary,
  type BlueskyCredentials,
  type ConnectBlueskyInput,
} from './bluesky-account';
export {
  deliverBlueskyAction,
  recordBlueskySent,
  type DeliverBlueskyDeps,
  type DeliverBlueskyInput,
  type DeliverBlueskyResult,
} from './outreach-bluesky';
export {
  advanceCadences,
  createCadence,
  setCadenceStatus,
  enrollInCadence,
  modeForDecision,
  stopEnrollment,
  type AdvanceCadencesDeps,
  type AdvanceResult,
  type DueEnrollment,
  type EnrollInput,
  type EnrollResult,
  type StepResolution,
  type CreateCadenceInput,
  type CreateCadenceResult,
} from './cadence';
export {
  trackLinksInBody,
  recordLinkClick,
  engagementFor,
  relationshipInputFrom,
  type TrackLinksInput,
  type TrackLinksResult,
  type RecordClickInput,
  type RecordClickResult,
  type EngagementFacts,
} from './engagement';
export {
  receiveReplies,
  workspacesWithReadableMailbox,
  type ReceiveRepliesInput,
  type ReceiveRepliesResult,
} from './receive-email';
export {
  deliverEmailAction,
  defaultEmailSubject,
  loadOutreachSettings,
  pickEmailRecipient,
  recordEmailFailure,
  recordEmailSent,
  AUTOPILOT_ACTOR,
  type AuditActor,
  type DeliverEmailDeps,
  type DeliverEmailResult,
  type EmailRecipient,
} from './outreach-email';
export {
  loadNotifySettings,
  notifyAddress,
  sendDailyDigest,
  sendLeadAlerts,
  type NotifyDeps,
  type NotifySettings,
} from './notify';
export {
  recordDiscovered,
  recordStatus,
  type StatusChange,
  type StatusChangeResult,
} from './stages';
export {
  emitEvent,
  pruneWorkflowEvents,
  readEvents,
  workflowStatus,
  WORKFLOW_LEVELS,
  WORKFLOW_PHASES,
  type QueueSnapshot,
  type ReadEventsQuery,
  type SendingSnapshot,
  type WorkflowEvent,
  type WorkflowEventInput,
  type WorkflowLevel,
  type WorkflowPhase,
  type WorkflowStatus,
} from './events';
export {
  campaignFunnel,
  leadTimeline,
  workspaceAnalytics,
  type FunnelQuery,
  type LeadTimeline,
  type WorkspaceAnalytics,
} from './analytics';
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

export {
  candidatesForPerson,
  confirmCandidate,
  knownPatternsForDomain,
  proposeAddresses,
  rejectCandidate,
  type DecisionInput,
  type EnrichCandidateRow,
  type ProposeResult,
} from './enrich';

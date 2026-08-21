/**
 * `@outreachgraph/contracts` — request and response schemas shared by the API,
 * the web app and the worker (PRD §1.1 principle 3, §24).
 *
 * The web app validates with the same schemas the API enforces, so a shape
 * change is a compile error on both sides rather than a runtime surprise.
 */

import { z } from 'zod';

export const API_VERSION = 'v1';

/** Errors are a single shape so clients can handle them uniformly. */
export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

export const campaignFiltersSchema = z.object({
  titles: z.array(z.string()).default([]),
  seniorities: z.array(z.string()).default([]),
  industries: z.array(z.string()).default([]),
  countries: z.array(z.string()).default([]),
  technologies: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([]),
  exclusions: z.array(z.string()).default([]),
  fundingStages: z.array(z.string()).default([]),
  employeeCountMin: z.number().int().positive().optional(),
  employeeCountMax: z.number().int().positive().optional(),
  hiring: z.boolean().optional(),
});

export const budgetSchema = z.object({
  maxProspects: z.number().int().positive().max(1_000_000),
  maxEnrichmentCredits: z.number().int().nonnegative(),
  maxResearchCredits: z.number().int().nonnegative(),
  maxAiSpendUsd: z.number().nonnegative(),
  maxActionsPerDay: z.number().int().nonnegative(),
  maxActionsPerProspectPerWeek: z.number().int().nonnegative(),
});

/**
 * The throughput and anti-spam knobs, tunable per campaign.
 *
 * These existed only as hard-coded fallbacks read from `campaigns.budget_json`,
 * which nothing ever wrote — so a workspace that wanted to send faster, or a
 * shared inbox that could stand more than one message a week, had no way to say
 * so short of a direct database write.
 *
 * Every field is bounded. The daily cap is throughput and is allowed to be
 * large; the per-recipient limits are what stop a mailbox being buried, so they
 * top out at one message a day however they are configured. A cap of 0 disables
 * that kind of outreach outright, which is a legitimate thing to want.
 */
export const campaignLimitsSchema = z
  .object({
    maxActionsPerDay: z.number().int().min(0).max(1_000),
    maxActionsPerProspectPerWeek: z.number().int().min(0).max(7),
    maxActionsPerAddressPerWeek: z.number().int().min(0).max(7),
    minHoursBetweenActions: z.number().int().min(0).max(168),
  })
  .partial();

export type CampaignLimits = z.infer<typeof campaignLimitsSchema>;

export const createCampaignSchema = z.object({
  name: z.string().min(1).max(200),
  offeringId: z.string().min(1),
  voiceProfileId: z.string().min(1).optional(),
  brief: z.string().max(4_000).optional(),
  filters: campaignFiltersSchema.optional(),
  networks: z.array(z.string()).default([]),
  approvalMode: z
    .enum(['research_only', 'draft_and_approve', 'trusted_automation'])
    // PRD §48 Decision 2: human approval is the default, automation is opt-in.
    .default('draft_and_approve'),
  budget: budgetSchema.partial().optional(),
  signalRules: z
    .array(
      z.object({
        type: z.string(),
        enabled: z.boolean().default(true),
        weight: z.number().min(0).max(10).default(1),
        keywords: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;

export const registerSchema = z.object({
  email: z.string().email().max(320),
  // Length beats composition rules; the API enforces the same floor.
  password: z.string().min(12).max(512),
  name: z.string().max(200).optional(),
  organizationName: z.string().max(200).optional(),
});

export const loginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(512),
});

/**
 * Asking for a reset link.
 *
 * Only the address, and the response is the same whatever it is — so this
 * schema's job is to reject junk before it reaches a mailer, not to tell the
 * caller anything about the account.
 */
export const forgotPasswordSchema = z.object({
  email: z.string().email().max(320),
});

/** Completing a reset. The password floor matches registration's. */
export const resetPasswordSchema = z.object({
  token: z.string().min(1).max(512),
  password: z.string().min(12).max(512),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

/**
 * Adding a prospect by GitHub handle.
 *
 * The pattern is GitHub's own rule — alphanumerics and single hyphens, never
 * leading or trailing, 39 characters max — so a typo is rejected here rather
 * than spending an API call to be told the profile does not exist. A pasted
 * profile URL is a common enough input that the API strips it before
 * validating; this schema sees only the handle.
 */
export const addProspectSchema = z.object({
  handle: z
    .string()
    .trim()
    .min(1)
    .max(39)
    .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/, 'not a valid GitHub username'),
});

export type AddProspectInput = z.infer<typeof addProspectSchema>;

/**
 * The workspace's own profile, as confirmed by a human.
 *
 * Lists are capped so a model that decides an ICP has forty job titles cannot
 * write forty rows of noise into the targeting filters. Everything except the
 * offering name and category is optional: a person who wants to fill in one
 * line and get on with it should be able to.
 *
 * Two length limits, because the lists are two different kinds of thing. A job
 * title or an industry is a *term*, and anything longer is the model narrating
 * instead of naming. A value proposition or a buyer's pain is a *sentence*, and
 * holding it to a term's length is what used to make setup unsavable: the model
 * would write a perfectly good 132-character line and the save rejected it.
 */
export const profileLimits = {
  term: 120,
  sentence: 300,
  entries: 20,
  label: 200,
  description: 4000,
  style: 500,
  instructions: 2000,
  url: 500,
} as const;

const termList = z
  .array(z.string().trim().min(1).max(profileLimits.term))
  .max(profileLimits.entries)
  .default([]);

const sentenceList = z
  .array(z.string().trim().min(1).max(profileLimits.sentence))
  .max(profileLimits.entries)
  .default([]);

export const workspaceProfileSchema = z.object({
  /**
   * Which product this profile describes.
   *
   * Absent means the workspace's first, which is what every caller meant when
   * a workspace could only have one. Present targets that product, so a second
   * product is an edit to a different row rather than an overwrite of the
   * first — which is exactly what saving one used to do.
   */
  offeringId: z.string().trim().min(1).max(64).optional(),
  url: z.string().trim().max(profileLimits.url).optional(),
  offering: z.object({
    name: z.string().trim().min(1).max(profileLimits.label),
    category: z.string().trim().min(1).max(profileLimits.label),
    description: z.string().trim().max(profileLimits.description).optional(),
    valuePropositions: sentenceList,
    likelyPains: sentenceList,
    competitors: termList,
  }),
  icp: z.object({
    titles: termList,
    seniorities: termList,
    industries: termList,
    technologies: termList,
    keywords: termList,
    exclusions: sentenceList,
  }),
  voice: z.object({
    style: z.string().trim().min(1).max(profileLimits.style),
    instructions: z.string().trim().max(profileLimits.instructions).optional(),
    maxWords: z.number().int().positive().max(400).optional(),
  }),
});

export type WorkspaceProfile = z.infer<typeof workspaceProfileSchema>;

export const createOfferingSchema = z.object({
  name: z.string().min(1).max(200),
  category: z.string().min(1).max(200),
  url: z.string().url().optional(),
  description: z.string().max(4_000).optional(),
  valuePropositions: z.array(z.string()).default([]),
  likelyPains: z.array(z.string()).default([]),
  competitors: z.array(z.string()).default([]),
});

export const peopleSearchSchema = z.object({
  campaignId: z.string().optional(),
  query: z.string().max(500).optional(),
  minOpportunity: z.number().int().min(0).max(100).optional(),
  status: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

export const enrichPersonSchema = z.object({
  fullName: z.string().min(1).optional(),
  email: z.string().email().optional(),
  companyDomain: z.string().optional(),
  companyName: z.string().optional(),
  title: z.string().optional(),
  handles: z.record(z.string(), z.string()).optional(),
});

export const approveRecommendationSchema = z.object({
  /** Present when the user rewrote the draft; feeds the edit-distance metric. */
  editedBody: z.string().max(10_000).optional(),
  note: z.string().max(1_000).optional(),
});

export const snoozeRecommendationSchema = z.object({
  until: z.string().datetime(),
});

export const createSuppressionSchema = z.object({
  matchKeys: z.array(z.string().min(3)).min(1),
  reason: z.enum([
    'consumer_opt_out',
    'customer_request',
    'complaint',
    'bounce',
    'do_not_contact',
    'minor',
    'legal_hold',
    'admin',
  ]),
  scope: z.enum(['global', 'organization', 'workspace']).default('workspace'),
});

export const privacyRequestSchema = z.object({
  kind: z.enum(['delete', 'opt_out', 'access', 'correct']),
  sourceChannel: z.enum(['drop', 'web_form', 'email', 'admin']),
  subjectMatchKeys: z.array(z.string().min(3)).min(1),
  note: z.string().max(2_000).optional(),
});

export const executeActionSchema = z.object({
  /**
   * `customer_managed` means "send it" — the product puts the message on the
   * wire through the workspace's connected mailbox. The others record that a
   * human or another system already did, which is all this route could do
   * before a mailbox could be connected.
   */
  mode: z.enum(['official_api', 'manual', 'crm', 'customer_managed']).default('manual'),
  externalUrl: z.string().url().optional(),
  note: z.string().max(1_000).optional(),
});

/**
 * Filling in the drafts a queue is missing.
 *
 * `limit` is capped because every card is a model call: the ceiling is what
 * stops "catch the queue up" from being an open-ended invoice.
 */
export const backfillDraftsSchema = z.object({
  limit: z.number().int().min(1).max(200).default(25),
});

/**
 * Recording that a contact wrote back.
 *
 * The product cannot see replies on its own — it sends through SMTP and reads
 * no mailbox — so until inbound polling exists this is how a reply becomes a
 * fact the policy engine can act on. It matters more than it looks: an
 * unrecorded reply leaves the contact in the cold-outreach pool, and mailing
 * someone who has already answered is the most bot-like thing we can do.
 */
export const recordReplySchema = z.object({
  /** When they replied. Defaults to now; accepted so backfills stay honest. */
  occurredAt: z.string().datetime().optional(),
  /** The reply itself, when the caller has it. */
  body: z.string().max(20_000).optional(),
  /**
   * The address that replied, for a shared inbox where the person who answered
   * is not necessarily the person written to. Defaults to the address the
   * outreach was delivered to.
   */
  fromAddress: z.string().email().optional(),
});

/**
 * Deciding on a proposed personal address.
 *
 * The address is required rather than a candidate id so the operator can
 * confirm one they simply know, which nothing derived. That is the input that
 * teaches a company's address shape to every colleague, so refusing it because
 * it was not on the list would throw away the most valuable answer available.
 */
export const decideEmailCandidateSchema = z.object({
  address: z.string().email(),
});

/**
 * Connecting the mailbox outreach is sent from.
 *
 * The password is write-only: it is accepted here, verified against the real
 * server, encrypted, and never returned by any route.
 */
export const connectEmailAccountSchema = z.object({
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65_535),
  /** True for implicit TLS (465); false for STARTTLS submission (587). */
  secure: z.boolean(),
  username: z.string().min(1).max(320),
  password: z.string().min(1).max(1_000),
  fromEmail: z.string().email(),
  fromName: z.string().max(120).optional(),
  replyTo: z.string().email().optional(),
  /**
   * Where the same mailbox is read from, so replies can be noticed.
   *
   * Optional, and no second password: IMAP and SMTP are two ports on one
   * mailbox. Leaving it out is a real choice — the workspace sends, and
   * handles replies by hand — but it means nothing can see an answer, so the
   * queue keeps offering prospects who are already mid-conversation.
   */
  imapHost: z.string().max(255).optional(),
  imapPort: z.number().int().min(1).max(65_535).optional(),
  imapSecure: z.boolean().optional(),
  /**
   * Skips the live login check. Off by default and deliberately awkward to
   * reach: an unverified credential produces a workspace that looks connected
   * and fails on its first real prospect.
   */
  skipVerification: z.boolean().optional(),
});

/** Health payload shared by every service (PRD §1.1 Docker requirements). */
export const healthSchema = z.object({
  status: z.enum(['ok', 'degraded', 'error']),
  service: z.string(),
  version: z.string(),
  commitHash: z.string().optional(),
  uptimeSeconds: z.number(),
});

export type HealthResponse = z.infer<typeof healthSchema>;

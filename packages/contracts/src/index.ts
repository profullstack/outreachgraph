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

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;

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
  mode: z.enum(['official_api', 'manual', 'crm']).default('manual'),
  externalUrl: z.string().url().optional(),
  note: z.string().max(1_000).optional(),
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

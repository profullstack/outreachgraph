/**
 * Server-side API client.
 *
 * The PWA never queries Turso — it goes through `/api/v1`, the same surface a
 * CLI or CRM plugin would use (PRD §24). Both run in one container, so this
 * calls the supervisor on loopback and forwards the caller's session cookie,
 * which is what makes every request act as the signed-in user rather than as
 * a shared service identity.
 */

import { cookies } from 'next/headers';
import type {
  ApprovalCard,
  CurrentUser,
  EmailIntegrationView,
  ProspectDetail,
  ProspectRow,
  SignalRow,
} from './types';

export type {
  ApprovalCard,
  CurrentUser,
  IdentityRow,
  ProspectDetail,
  ProspectRow,
  SignalRow,
} from './types';
export { relativeTime } from './format';

/**
 * Reads an environment variable at request time.
 *
 * Next.js statically replaces `process.env.SOME_NAME` during the build, so a
 * variable absent at build time is baked in as `undefined` forever — the
 * deployed app once dropped its auth headers this way and 401'd on every
 * request. Indexing with a non-literal key defeats that substitution.
 */
function runtimeEnv(name: string): string | undefined {
  const key = String(name);
  return process.env[key];
}

/** The supervisor's port; the API is mounted on it under /api. */
function baseUrl(): string {
  return runtimeEnv('INTERNAL_API_URL') ?? `http://127.0.0.1:${runtimeEnv('PORT') ?? '8080'}`;
}

export class ApiUnavailableError extends Error {
  constructor(cause: unknown) {
    super('the API is not reachable');
    this.name = 'ApiUnavailableError';
    this.cause = cause;
  }
}

/** The caller is not signed in. Pages turn this into a redirect to /login. */
export class NotAuthenticatedError extends Error {
  constructor() {
    super('not signed in');
    this.name = 'NotAuthenticatedError';
  }
}

/**
 * `cache: 'no-store'` because approval state and policy decisions must never
 * be stale — the same reason the service worker refuses to cache `/api`.
 */
async function request<T>(path: string): Promise<T> {
  const jar = await cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  let response: Response;

  try {
    response = await fetch(`${baseUrl()}/api/v1${path}`, {
      cache: 'no-store',
      headers: cookieHeader ? { cookie: cookieHeader } : {},
    });
  } catch (error) {
    throw new ApiUnavailableError(error);
  }

  if (response.status === 401 || response.status === 403) {
    throw new NotAuthenticatedError();
  }

  if (!response.ok) {
    throw new Error(`API ${response.status} for ${path}`);
  }

  return (await response.json()) as T;
}

export async function fetchMe(): Promise<CurrentUser> {
  return request<CurrentUser>('/auth/me');
}

/** What the workspace believes about itself, for the setup page. */
export interface WorkspaceProfileView {
  readonly configured: boolean;
  readonly url?: string;
  readonly offering?: { readonly name: string; readonly category: string };
}

export async function fetchProfile(): Promise<WorkspaceProfileView> {
  return request<WorkspaceProfileView>('/onboarding/profile');
}

export async function fetchApprovals(): Promise<ApprovalCard[]> {
  const body = await request<{ recommendations: ApprovalCard[] }>('/recommendations?limit=50');
  return body.recommendations;
}

export async function fetchSignals(): Promise<SignalRow[]> {
  const body = await request<{ signals: SignalRow[] }>('/signals?limit=50');
  return body.signals;
}

export async function fetchProspects(): Promise<ProspectRow[]> {
  const body = await request<{ people: ProspectRow[] }>('/people?limit=100');
  return body.people;
}

export async function fetchProspect(id: string): Promise<ProspectDetail> {
  return request<ProspectDetail>(`/people/${encodeURIComponent(id)}`);
}

export interface CampaignRow {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly approval_mode: string;
  readonly seed_kind: string | null;
  readonly seed_value: string | null;
  readonly created_at: string;
  readonly started_at: string | null;
}

export async function fetchCampaigns(): Promise<CampaignRow[]> {
  const body = await request<{ campaigns: CampaignRow[] }>('/campaigns');
  return body.campaigns;
}

export interface FunnelStageView {
  readonly stage: string;
  readonly label: string;
  readonly current: number;
  readonly reached: number;
}

export interface AnalyticsView {
  readonly funnel: {
    readonly stages: readonly FunnelStageView[];
    readonly lost: number;
    readonly total: number;
  };
  readonly sentThisWeek: number;
  readonly repliesThisWeek: number;
  readonly awaitingApproval: number;
  readonly activeCampaigns: number;
  readonly autopilotCampaigns: number;
  readonly medianHoursToContact?: number;
}

export async function fetchAnalytics(campaignId?: string): Promise<AnalyticsView> {
  const query = campaignId ? `?campaignId=${encodeURIComponent(campaignId)}` : '';
  return request<AnalyticsView>(`/analytics${query}`);
}

export interface TimelineSegmentView {
  readonly stage: string;
  readonly enteredAt: string;
  readonly leftAt?: string;
  readonly hours?: number;
}

export interface LeadTimelineView {
  readonly personId: string;
  readonly personName: string;
  readonly companyName?: string;
  readonly currentStage: string;
  readonly opportunity?: number;
  readonly firstSeenAt: string;
  readonly segments: readonly TimelineSegmentView[];
}

export async function fetchTimeline(campaignId?: string): Promise<LeadTimelineView[]> {
  const query = campaignId ? `?campaignId=${encodeURIComponent(campaignId)}&limit=50` : '?limit=50';
  const body = await request<{ leads: LeadTimelineView[] }>(`/analytics/timeline${query}`);
  return body.leads;
}

export interface SettingsView {
  readonly notifyEmail: string | null;
  readonly effectiveNotifyEmail: string | null;
  readonly instantAlerts: boolean;
  readonly dailyDigest: boolean;
  readonly digestHourUtc: number;
  readonly alertMinOpportunity: number;
  readonly autopilotDailyCap: number;
  readonly replyToEmail: string | null;
  readonly lastDigestSentOn: string | null;
}

export async function fetchSettings(): Promise<SettingsView> {
  return request<SettingsView>('/settings');
}

export async function fetchEmailIntegration(): Promise<EmailIntegrationView> {
  return request<EmailIntegrationView>('/integrations/email');
}

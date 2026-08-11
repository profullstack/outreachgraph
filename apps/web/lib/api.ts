/**
 * API client.
 *
 * The web app never queries Turso directly — it goes through `/api/v1`, the
 * same surface a CLI or CRM plugin would use (PRD §24).
 */

/**
 * Reads an environment variable at request time.
 *
 * Next.js statically replaces `process.env.SOME_NAME` during the build, so a
 * variable that is absent at build time is baked in as `undefined` forever —
 * the deployed app silently dropped its auth headers and every request came
 * back 401. Indexing with a non-literal key defeats that substitution, so the
 * value is genuinely read from the running container's environment.
 */
function runtimeEnv(name: string): string | undefined {
  const key = String(name);
  return process.env[key];
}

// NEXT_PUBLIC_* is intended to be inlined, so it stays a direct reference.
const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';

export interface ApprovalCard {
  id: string;
  person_id: string;
  display_name: string;
  current_title: string | null;
  action: string;
  network: string;
  priority: number;
  reason: string;
  identity_confidence: number;
  opportunity: number | null;
  signal_summary: string | null;
  signal_url: string | null;
  signal_at: string | null;
  draft_body: string | null;
  draft_subject: string | null;
}

export interface SignalRow {
  id: string;
  person_id: string | null;
  display_name: string | null;
  network: string;
  signal_type: string;
  summary: string;
  source_url: string | null;
  source_timestamp: string | null;
  relevance: number;
}

export class ApiUnavailableError extends Error {
  constructor(cause: unknown) {
    super('the API is not reachable');
    this.name = 'ApiUnavailableError';
    this.cause = cause;
  }
}

/**
 * The API answered, but refused. Distinct from unreachable because the fix is
 * different — misconfigured credentials, not a service that is down — and
 * because a 401 must render an explanation rather than crash the page.
 */
export class ApiAuthError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`the API rejected these credentials (${status})`);
    this.name = 'ApiAuthError';
    this.status = status;
  }
}

/**
 * Server-side fetch. `cache: 'no-store'` because approval state and policy
 * decisions must never be served stale — the same reason the service worker
 * refuses to cache `/api`.
 */
async function request<T>(path: string): Promise<T> {
  const token = runtimeEnv('API_TOKEN');
  const workspaceId = runtimeEnv('WORKSPACE_ID');
  const organizationId = runtimeEnv('ORGANIZATION_ID');

  let response: Response;

  try {
    response = await fetch(`${BASE_URL}/api/v1${path}`, {
      cache: 'no-store',
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}),
        ...(organizationId ? { 'x-organization-id': organizationId } : {}),
      },
    });
  } catch (error) {
    throw new ApiUnavailableError(error);
  }

  if (response.status === 401 || response.status === 403) {
    throw new ApiAuthError(response.status);
  }

  if (!response.ok) {
    throw new Error(`API ${response.status} for ${path}`);
  }

  return (await response.json()) as T;
}

export async function fetchApprovals(): Promise<ApprovalCard[]> {
  const body = await request<{ recommendations: ApprovalCard[] }>('/recommendations?limit=50');
  return body.recommendations;
}

export async function fetchSignals(): Promise<SignalRow[]> {
  const body = await request<{ signals: SignalRow[] }>('/signals?limit=50');
  return body.signals;
}

/** Relative time for the "4 hours ago" line on every card. */
export function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';

  const seconds = Math.round((Date.now() - then) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 7],
    ['week', 4.35],
    ['month', 12],
    ['year', Number.POSITIVE_INFINITY],
  ];

  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  let value = -seconds;

  for (const [unit, size] of units) {
    if (Math.abs(value) < size) return formatter.format(Math.round(value), unit);
    value /= size;
  }
  return '';
}

/**
 * API client.
 *
 * The web app never queries Turso directly — it goes through `/api/v1`, the
 * same surface a CLI or CRM plugin would use (PRD §24).
 */

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
 * Server-side fetch. `cache: 'no-store'` because approval state and policy
 * decisions must never be served stale — the same reason the service worker
 * refuses to cache `/api`.
 */
async function request<T>(path: string): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${BASE_URL}/api/v1${path}`, {
      cache: 'no-store',
      headers: {
        ...(process.env.API_TOKEN ? { authorization: `Bearer ${process.env.API_TOKEN}` } : {}),
        ...(process.env.WORKSPACE_ID ? { 'x-workspace-id': process.env.WORKSPACE_ID } : {}),
        ...(process.env.ORGANIZATION_ID
          ? { 'x-organization-id': process.env.ORGANIZATION_ID }
          : {}),
      },
    });
  } catch (error) {
    throw new ApiUnavailableError(error);
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

/**
 * Shapes shared by server and client components.
 *
 * Deliberately free of any import: `lib/api.ts` pulls in `next/headers`, which
 * is server-only, so a client component importing a type from there would drag
 * the server module into the browser bundle and fail the build.
 */

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

export interface CurrentUser {
  user: { id: string; email: string | null; name: string | null };
  workspaceId: string;
  role: string;
}

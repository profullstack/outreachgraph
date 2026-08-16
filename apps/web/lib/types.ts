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

/** One thing the workspace sells. A workspace may sell several. */
export interface ProductSummaryView {
  offeringId: string;
  name: string;
  category: string;
  url: string | null;
  campaignId: string | null;
  campaignStatus: string | null;
  autopilot: boolean;
  /** False for the placeholder a first campaign bootstraps. */
  configured: boolean;
}

/** The mailbox outreach is sent from. Never carries the password. */
export interface EmailAccountView {
  connected: boolean;
  host?: string;
  port?: number;
  secure?: boolean;
  username?: string;
  fromEmail?: string;
  fromName?: string;
  replyTo?: string;
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  status?: string;
  connectedAt?: string;
}

export interface SmtpPresetView {
  id: string;
  label: string;
  host: string;
  port: number;
  secure: boolean;
  note?: string;
  /** The read side of the same mailbox, so one choice fills in both. */
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
}

export interface EmailIntegrationView {
  account: EmailAccountView;
  /** False when the deployment has no encryption key to store a password with. */
  canConnect: boolean;
  /** True when the platform sender can deliver without a connected mailbox. */
  platformFallback: boolean;
  presets: SmtpPresetView[];
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

export interface ProspectRow {
  id: string;
  display_name: string;
  current_title: string | null;
  current_company: string | null;
  identity_confidence: number;
  prospect_status: string;
  interaction_state: string;
  opportunity: number | null;
  icp_fit: number | null;
  intent: number | null;
  reachability: number | null;
  signal_count: number;
}

export interface IdentityRow {
  id: string;
  network: string;
  handle: string;
  confidence: number;
  source_type: string | null;
}

export interface ProspectDetail {
  person: {
    id: string;
    display_name: string;
    current_title: string | null;
    identity_confidence: number;
    status: string;
  };
  identities: IdentityRow[];
  signals: SignalRow[];
}

export interface CurrentUser {
  user: { id: string; email: string | null; name: string | null };
  emailVerified: boolean;
  workspaceId: string;
  role: string;
}

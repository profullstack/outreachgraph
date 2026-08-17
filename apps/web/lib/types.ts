/**
 * Shapes shared by server and client components.
 *
 * Deliberately free of any import: `lib/api.ts` pulls in `next/headers`, which
 * is server-only, so a client component importing a type from there would drag
 * the server module into the browser bundle and fail the build.
 */

/**
 * Which tab of the approvals queue a card belongs to.
 *
 * `all` is a view, never a card's own bucket — every card is exactly one of
 * the other three.
 */
export type ApprovalBucket = 'ready' | 'needs_draft' | 'research';

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
  /**
   * Computed by the API, not the browser. The tabs filter on this, so it has
   * to be the same classification the counts are derived from — recomputing
   * it here from `action` and `draft_body` would be a second implementation
   * of a rule that already exists in SQL, free to drift from it.
   */
  bucket: ApprovalBucket;

  /**
   * Present when the address limits will refuse this card if it is approved.
   *
   * The card renders it instead of letting the reviewer find out by clicking.
   * It is advisory: the API re-runs the whole policy engine on approval, so a
   * card without a hold can still be refused for some other reason, and the
   * refusal is always the authority.
   */
  hold?: ApprovalHold;
}

/** Why a card cannot be approved yet, and when that changes. */
export interface ApprovalHold {
  gate: string;
  reason: string;
  /** The mailbox the message would reach — the thing the limit is counted on. */
  address: string;
  /** True when that mailbox is the company's, shared with colleagues. */
  shared: boolean;
  clears_at?: string;
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

/**
 * Where one campaign listens.
 *
 * Per campaign rather than per deployment: two products sold to two different
 * trades have no reason to watch the same communities.
 */
export interface ListeningView {
  campaignId: string;
  sources: string[];
  subreddits: string[];
  feeds: string[];
  /** Every source this build supports, for rendering the choices. */
  available: string[];
  /** What it would search for, from the ICP keywords and competitors. */
  terms: string[];
}

export interface SubredditSuggestionView {
  name: string;
  title: string;
  subscribers: number;
  description: string;
  url: string;
  matchedTerms: string[];
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

/**
 * A profile the prospect's employer published, not one of theirs.
 *
 * Kept as its own row type so the page cannot render it as if the person owned
 * it. `company_name` rides along because "the company's X account" needs the
 * company named to mean anything.
 */
export interface CompanyIdentityRow {
  id: string;
  company_id: string;
  company_name: string | null;
  network: string;
  handle: string | null;
  profile_url: string | null;
  confidence: number;
  source_url: string | null;
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
  companyIdentities: CompanyIdentityRow[];
  signals: SignalRow[];
  /** Optional: a cached page from before addresses were proposed has none. */
  emailCandidates?: EmailCandidateRow[];
}

/**
 * A proposed personal address, which is a question rather than a fact.
 *
 * Nothing here can be sent to. Confirming one writes the email identity the
 * sender actually reads, and that is the only way a prospect stops resolving
 * to their company's shared inbox.
 */
export interface EmailCandidateRow {
  id: string;
  address: string;
  pattern: string;
  /** 1 when the shape was learned from a confirmed address at this company. */
  derived: number;
  confidence: number;
  status: string;
  basis: string | null;
}

export interface CurrentUser {
  user: { id: string; email: string | null; name: string | null };
  emailVerified: boolean;
  workspaceId: string;
  role: string;
}

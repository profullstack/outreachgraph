/**
 * Outbound events: what the product tells the rest of a customer's stack
 * (PRD §28).
 *
 * The list below is a contract with code we do not own. A Zapier zap, a Make
 * scenario or a hand-written receiver branches on `type`, so a name here is
 * never renamed and never reused for a different meaning — a new fact gets a
 * new name. Past tense throughout, because every event reports something that
 * has already happened and been written; nothing here is a request.
 *
 * `ping` is deliberately not in the list. It is what "send a test" fires at one
 * endpoint, and an endpoint subscribed to everything must not start receiving
 * it because someone else pressed a button.
 */

export const WEBHOOK_EVENT_TYPES = [
  /** Somebody we wrote to wrote back. */
  'reply.received',
  /** A person (not a link scanner) opened a tracked link. */
  'link.clicked',
  /** A person joined a campaign. */
  'prospect.created',
  /** A reviewer, or trusted automation, said yes to a card. */
  'recommendation.approved',
  /** An approved action actually went out. */
  'action.sent',
  /** A person reached the end of a cadence. */
  'cadence.completed',
  /** A person is never to be contacted again. */
  'person.suppressed',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** Everything a delivery can carry, including the test event. */
export type DeliverableEventType = WebhookEventType | 'ping';

export function isWebhookEventType(value: unknown): value is WebhookEventType {
  return typeof value === 'string' && (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * How an endpoint wants its events.
 *
 * `generic` is signed JSON for anything that can receive a POST — including
 * Zapier, Make and n8n, which is why none of those three has its own kind.
 * `slack` is an incoming-webhook URL, which takes a message and not our event,
 * and cannot check a signature anyway.
 */
export const WEBHOOK_ENDPOINT_KINDS = ['generic', 'slack'] as const;
export type WebhookEndpointKind = (typeof WEBHOOK_ENDPOINT_KINDS)[number];

/** The CRMs a workspace can push to. */
export const CRM_PROVIDERS = ['hubspot', 'pipedrive'] as const;
export type CrmProvider = (typeof CRM_PROVIDERS)[number];

export function isCrmProvider(value: unknown): value is CrmProvider {
  return typeof value === 'string' && (CRM_PROVIDERS as readonly string[]).includes(value);
}

/**
 * The events a CRM hears about.
 *
 * Two, on purpose. A CRM is where a sales team keeps the people it is actually
 * talking to, and "we found this person on a crawl" is not that — pushing every
 * prospect would bury the handful who answered under thousands who never will.
 * A reply is the moment someone becomes a conversation; an approval is the
 * moment a human decided to start one.
 */
export const CRM_TRIGGER_EVENTS: readonly WebhookEventType[] = [
  'reply.received',
  'recommendation.approved',
];

/**
 * Whether an endpoint subscribed to `type`.
 *
 * An empty filter means everything, which is the useful default for a Zapier
 * hook that branches on its own side. `*` is accepted as a spelling of the
 * same thing because it is what people type.
 */
export function endpointWants(filter: readonly string[], type: DeliverableEventType): boolean {
  if (type === 'ping') return false;
  if (filter.length === 0) return true;
  return filter.includes('*') || filter.includes(type);
}

/**
 * The events an endpoint subscribes to, cleaned.
 *
 * Unknown names are an error rather than silently dropped: a typo such as
 * `reply.recieved` would otherwise produce an endpoint that is subscribed to
 * nothing and looks exactly like one that is working.
 */
export function normaliseEventFilter(
  input: readonly string[] | undefined,
): { ok: true; events: WebhookEventType[] } | { ok: false; unknown: string[] } {
  const cleaned = [...new Set((input ?? []).map((value) => value.trim()).filter(Boolean))];
  if (cleaned.includes('*')) return { ok: true, events: [] };

  const unknown = cleaned.filter((value) => !isWebhookEventType(value));
  if (unknown.length > 0) return { ok: false, unknown };

  return { ok: true, events: cleaned as WebhookEventType[] };
}

/** Who an event is about, as much as a receiver needs to act without calling back. */
export interface EventPerson {
  readonly id: string;
  readonly name: string;
  readonly title?: string;
  readonly company?: string;
  readonly companyDomain?: string;
  /** A personal address we hold for them. Never their company's shared inbox. */
  readonly email?: string;
}

/**
 * The envelope every delivery carries.
 *
 * `id` is stable across retries of one delivery, so a receiver that has seen
 * it can answer 200 and do nothing. `data` is per type and additive: fields
 * may be added, never removed or repurposed.
 */
export interface OutboundEvent {
  readonly id: string;
  readonly type: DeliverableEventType;
  readonly createdAt: string;
  readonly workspaceId: string;
  readonly data: Readonly<Record<string, unknown>> & { readonly person?: EventPerson };
}

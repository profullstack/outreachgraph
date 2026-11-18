/**
 * The CRM and the booking page (PRD §39): pure rules, no database.
 *
 * A **deal** is one relationship the workspace is working: who, at what
 * stage, what happens next. It may point at a `people` row, but it does not
 * have to: people rows are global identity records with an evidence bar
 * (PRD §8), and someone who booked a call has cleared no such bar. So a deal
 * carries its own name, email and company as the workspace typed (or the
 * guest gave) them.
 *
 * **Activities** are the timeline: notes, call notes, meetings, emails, and
 * the stage changes the API writes on its own. **Reminders** are dated
 * to-dos that the worker mails to whoever they are assigned to.
 *
 * The **booking page** is a public Calendly-style page at
 * `/calendar/<handle>`. Every booking is a PairUX call: the link is an
 * anonymous end-to-end-encrypted room (`pairux.com/r/<room>#k=<key>`) made
 * here with no call to PairUX, because the room *is* the link and the key in
 * the fragment never reaches a server.
 */

export const CRM_STAGES = [
  'lead',
  'contacted',
  'replied',
  'meeting',
  'proposal',
  'won',
  'lost',
] as const;
export type CrmStage = (typeof CRM_STAGES)[number];

/** Stages a deal can sit in while it is still being worked. */
export const OPEN_CRM_STAGES: readonly CrmStage[] = [
  'lead',
  'contacted',
  'replied',
  'meeting',
  'proposal',
];

export function isCrmStage(value: unknown): value is CrmStage {
  return typeof value === 'string' && (CRM_STAGES as readonly string[]).includes(value);
}

export function isClosedStage(stage: CrmStage): boolean {
  return stage === 'won' || stage === 'lost';
}

export const CRM_ACTIVITY_KINDS = ['note', 'call', 'meeting', 'email', 'stage'] as const;
export type CrmActivityKind = (typeof CRM_ACTIVITY_KINDS)[number];

/** Kinds a person or agent may log. `stage` is written by the API alone. */
export const LOGGABLE_ACTIVITY_KINDS: readonly CrmActivityKind[] = [
  'note',
  'call',
  'meeting',
  'email',
];

export function isLoggableActivityKind(value: unknown): value is CrmActivityKind {
  return (
    typeof value === 'string' && (LOGGABLE_ACTIVITY_KINDS as readonly string[]).includes(value)
  );
}

export const CRM_LIMITS = {
  title: 200,
  name: 200,
  email: 320,
  company: 200,
  nextStep: 500,
  body: 20_000,
  reminder: 500,
  bookingTitle: 120,
  bookingDescription: 2_000,
  guestNote: 2_000,
} as const;

/** Trims, collapses control characters, and cuts to a length. Empty becomes null. */
export function cleanCrmText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
}

const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;

/** A plausible address, lowercased, or null. Deliverability is not this function's job. */
export function cleanEmail(value: unknown): string | null {
  const text = cleanCrmText(value, CRM_LIMITS.email);
  if (!text) return null;
  const lower = text.toLowerCase();
  return EMAIL.test(lower) ? lower : null;
}

// ------------------------------------------------------------- booking page

/** Handles are lowercase, start with a letter or digit, and may hold `-` and `_`. */
const HANDLE = /^[a-z0-9][a-z0-9_-]{1,39}$/;

/** Paths a handle may not take because they would read as something else. */
const RESERVED_HANDLES = new Set([
  'api',
  'admin',
  'new',
  'edit',
  'settings',
  'login',
  'signup',
  'booking',
  'bookings',
  'cancel',
  'help',
  'outreachgraph',
]);

export function normaliseHandle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const handle = value.trim().toLowerCase().replace(/^@/, '');
  if (!HANDLE.test(handle) || RESERVED_HANDLES.has(handle)) return null;
  return handle;
}

export const BOOKING_DURATIONS = [15, 20, 30, 45, 60, 90] as const;

export function isBookingDuration(value: unknown): value is number {
  return typeof value === 'number' && (BOOKING_DURATIONS as readonly number[]).includes(value);
}

/** How many days the public page lets a guest look ahead, at most. */
export const BOOKING_MAX_DAYS_AHEAD = 90;

/** Minutes before a booked call that the host and the guest are reminded. */
export const BOOKING_REMINDER_LEAD_MINUTES = 60;

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function base64url(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += B64URL[(value >> bits) & 63];
    }
  }
  if (bits > 0) out += B64URL[(value << (6 - bits)) & 63];
  return out;
}

/**
 * A fresh anonymous PairUX room: `https://pairux.com/r/<22-char id>#k=<43-char key>`.
 *
 * The same shape PairUX's own generator makes (16 random bytes for the room,
 * 32 for the AES key), so the link opens a normal end-to-end-encrypted room.
 * Nothing is registered with PairUX: the first person to open the link
 * creates the room, and only holders of the fragment can decrypt it.
 */
export function newPairuxRoomUrl(
  random: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes),
  origin = 'https://pairux.com',
): string {
  const room = base64url(random(new Uint8Array(16)));
  const key = base64url(random(new Uint8Array(32)));
  return `${origin}/r/${room}#k=${key}`;
}

// ------------------------------------------------------------- calendar file

function icsEscape(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function icsTime(iso: string): string {
  return new Date(iso)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/** Folds a content line at 75 octets, as RFC 5545 asks. */
function fold(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [];
  for (let index = 0; index < line.length; index += 74) parts.push(line.slice(index, index + 74));
  return parts.join('\r\n ');
}

export interface IcsEvent {
  readonly uid: string;
  readonly start: string;
  readonly end: string;
  readonly summary: string;
  readonly description: string;
  readonly url: string;
  readonly organizerEmail?: string;
  readonly organizerName?: string;
  readonly attendeeEmail?: string;
  readonly attendeeName?: string;
  readonly cancelled?: boolean;
  readonly sequence?: number;
  readonly stamp?: string;
}

/** One VEVENT in a VCALENDAR, ready to download as `.ics`. */
export function buildIcs(event: IcsEvent): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//OutreachGraph//Calendar//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${event.cancelled ? 'CANCEL' : 'PUBLISH'}`,
    'BEGIN:VEVENT',
    `UID:${event.uid}@outreachgraph.com`,
    `DTSTAMP:${icsTime(event.stamp ?? new Date().toISOString())}`,
    `DTSTART:${icsTime(event.start)}`,
    `DTEND:${icsTime(event.end)}`,
    `SEQUENCE:${String(event.sequence ?? 0)}`,
    `SUMMARY:${icsEscape(event.summary)}`,
    `DESCRIPTION:${icsEscape(event.description)}`,
    `LOCATION:${icsEscape(event.url)}`,
    `URL:${event.url}`,
    `STATUS:${event.cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
  ];
  if (event.organizerEmail) {
    const name = event.organizerName ? `;CN=${icsEscape(event.organizerName)}` : '';
    lines.push(`ORGANIZER${name}:mailto:${event.organizerEmail}`);
  }
  if (event.attendeeEmail) {
    const name = event.attendeeName ? `;CN=${icsEscape(event.attendeeName)}` : '';
    lines.push(`ATTENDEE${name};ROLE=REQ-PARTICIPANT:mailto:${event.attendeeEmail}`);
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

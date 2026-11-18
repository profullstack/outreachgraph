/**
 * `og crm` and `og cal` — the CRM and the booking page from a terminal.
 *
 * Clients of `/api/v1/crm` and `/api/v1/calendar` (PRD §39). `og crm` with no
 * arguments prints what needs doing: the pipeline, due reminders, upcoming
 * calls and quiet deals. `--json` anywhere prints the raw response instead.
 */

import type { Command, CommandContext } from './commands';

type Rec = Record<string, unknown>;

function text(record: Rec, key: string, fallback = ''): string {
  const value = record[key];
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function rows(value: unknown, key: string): readonly Rec[] {
  const list = (value as Rec)[key];
  return Array.isArray(list) ? (list as Rec[]) : [];
}

function flag(flags: CommandContext['flags'], key: string): string | undefined {
  const value = flags[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function when(iso: unknown): string {
  if (typeof iso !== 'string') return '-';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function money(cents: unknown): string {
  const n = Number(cents ?? 0);
  return n ? `$${(n / 100).toLocaleString()}` : '';
}

function dealLine(deal: Rec): string {
  const who = [text(deal, 'contactName'), text(deal, 'contactEmail')].filter(Boolean).join(' ');
  const value = money(deal.valueCents);
  return (
    `${text(deal, 'id')}  [${text(deal, 'stage')}]  ${text(deal, 'title')}` +
    (who ? `  ${who}` : '') +
    (value ? `  ${value}` : '') +
    (deal.nextStep ? `\n   next: ${text(deal, 'nextStep')}` : '')
  );
}

function reminderLine(reminder: Rec): string {
  return (
    `${text(reminder, 'id')}  ${when(reminder.dueAt)}  ${text(reminder, 'title')}` +
    (reminder.dealTitle ? `  (${text(reminder, 'dealTitle')})` : '') +
    (reminder.doneAt ? '  done' : '')
  );
}

function bookingLine(booking: Rec): string {
  return (
    `${text(booking, 'id')}  ${when(booking.startsAt)}  ${text(booking, 'guestName')} ` +
    `<${text(booking, 'guestEmail')}>  ${text(booking, 'status')}\n   ${text(booking, 'meetingUrl')}`
  );
}

/** Copies the deal flags a caller gave into a request body. */
function dealBody(flags: CommandContext['flags']): Rec {
  const body: Rec = {};
  const map: Record<string, string> = {
    title: 'title',
    name: 'contactName',
    email: 'contactEmail',
    company: 'company',
    stage: 'stage',
    next: 'nextStep',
    person: 'personId',
    note: 'note',
  };
  for (const [from, to] of Object.entries(map)) {
    const value = flag(flags, from);
    if (value !== undefined) body[to] = value;
  }
  const value = flag(flags, 'value');
  if (value !== undefined) body.value = Number(value);
  return body;
}

export const CRM_USAGE = [
  'og crm                                     what needs doing: pipeline, due reminders, calls, quiet deals',
  'og crm sync                                pull sends, replies, bounces and opt-outs from outreach now',
  'og crm deals [--stage s] [--email e] [--q text]',
  'og crm deal <dealId>                       one deal with its timeline, reminders and calls',
  'og crm add [--title t] [--name n] [--email e] [--company c] [--stage s] [--value 1200] [--next "..."] [--note "..."]',
  'og crm set <dealId> [--stage s] [--next "..."] [--value n] [--name n] [--email e] [--company c] [--title t]',
  'og crm note <dealId> "text" [--kind note|call|meeting|email] [--minutes 30]',
  'og crm remind "title" --due 2026-12-01T17:00 [--deal <dealId>]',
  'og crm reminders [--status open|done|all]',
  'og crm done <reminderId>',
  'stages: lead contacted replied meeting proposal won lost',
].join('\n');

export const CAL_USAGE = [
  'og cal                                     your booking page and its link',
  'og cal set [--handle h] [--title t] [--name "Host"] [--minutes 30] [--tz America/Los_Angeles] [--hours mon-fri=09:00-17:00] [--notice 240] [--ahead 30] [--on|--off]',
  'og cal bookings [--past|--all]',
  'og cal cancel <bookingId>',
].join('\n');

async function runCrm({ client, args, flags }: CommandContext): Promise<string> {
  const [sub, ...rest] = args;
  const json = flags.json === true;
  const out = (value: unknown, render: () => string) =>
    json ? JSON.stringify(value, null, 2) : render();

  if (!sub || sub === 'summary') {
    const summary = (await client.get('/crm/summary')) as Rec;
    return out(summary, () => {
      const stages = rows(summary, 'stages')
        .map(
          (s) =>
            `${text(s, 'stage')} ${text(s, 'deals')}${money(s.valueCents) ? ` (${money(s.valueCents)})` : ''}`,
        )
        .join('  ·  ');
      const due = rows(summary, 'dueReminders');
      const calls = rows(summary, 'upcomingBookings');
      const stale = rows(summary, 'staleDeals');
      return [
        `Pipeline: ${stages}`,
        '',
        `Due reminders (${String(due.length)}):`,
        ...(due.length ? due.map(reminderLine) : ['  none']),
        '',
        `Upcoming calls (${String(calls.length)}):`,
        ...(calls.length ? calls.map(bookingLine) : ['  none']),
        '',
        `Quiet for 14+ days (${String(stale.length)}):`,
        ...(stale.length ? stale.map(dealLine) : ['  none']),
      ].join('\n');
    });
  }

  if (sub === 'sync') {
    const result = (await client.post('/crm/sync', {})) as Rec;
    return out(
      result,
      () =>
        `Synced ${text(result, 'interactions')} outreach event(s): ${text(result, 'dealsCreated')} new deal(s), ` +
        `${text(result, 'suppressions')} suppression(s), ${text(result, 'linked')} linked by email.`,
    );
  }

  if (sub === 'deals') {
    const result = await client.get('/crm/deals', {
      stage: flag(flags, 'stage'),
      email: flag(flags, 'email'),
      q: flag(flags, 'q') ?? (rest.join(' ') || undefined),
    });
    return out(result, () => rows(result, 'deals').map(dealLine).join('\n') || 'No deals yet.');
  }

  if (sub === 'deal') {
    const id = rest[0];
    if (!id) throw new Error(CRM_USAGE);
    const result = (await client.get(`/crm/deals/${encodeURIComponent(id)}`)) as Rec;
    return out(result, () =>
      [
        dealLine((result.deal ?? {}) as Rec),
        '',
        'Timeline:',
        ...rows(result, 'activities').map(
          (a) =>
            `  ${when(a.occurredAt)}  ${text(a, 'kind')}${a.durationMinutes ? ` ${text(a, 'durationMinutes')}m` : ''}: ${text(a, 'body').replace(/\n/g, '\n    ')}`,
        ),
        '',
        'Reminders:',
        ...rows(result, 'reminders').map((r) => `  ${reminderLine(r)}`),
        '',
        'Calls:',
        ...rows(result, 'bookings').map((b) => `  ${bookingLine(b)}`),
      ].join('\n'),
    );
  }

  if (sub === 'add') {
    const result = (await client.post('/crm/deals', dealBody(flags))) as Rec;
    return out(result, () => `Added ${dealLine((result.deal ?? {}) as Rec)}`);
  }

  if (sub === 'set') {
    const id = rest[0];
    if (!id) throw new Error(CRM_USAGE);
    if (!client.patch) throw new Error('this client cannot edit');
    const body = dealBody(flags);
    delete body.note;
    const result = (await client.patch(`/crm/deals/${encodeURIComponent(id)}`, body)) as Rec;
    return out(result, () => `Updated ${dealLine((result.deal ?? {}) as Rec)}`);
  }

  if (sub === 'note') {
    const [id, ...words] = rest;
    const body = words.join(' ').trim() || flag(flags, 'text');
    if (!id || !body) throw new Error(CRM_USAGE);
    const minutes = flag(flags, 'minutes');
    const result = await client.post(`/crm/deals/${encodeURIComponent(id)}/activities`, {
      kind: flag(flags, 'kind') ?? 'note',
      body,
      ...(minutes ? { durationMinutes: Number(minutes) } : {}),
    });
    return out(result, () => 'Logged.');
  }

  if (sub === 'remind') {
    const title = rest.join(' ').trim() || flag(flags, 'title');
    const due = flag(flags, 'due');
    if (!title || !due) throw new Error(CRM_USAGE);
    const result = (await client.post('/crm/reminders', {
      title,
      dueAt: new Date(due).toISOString(),
      ...(flag(flags, 'deal') ? { dealId: flag(flags, 'deal') } : {}),
    })) as Rec;
    return out(result, () => `Set ${reminderLine((result.reminder ?? {}) as Rec)}`);
  }

  if (sub === 'reminders') {
    const result = await client.get('/crm/reminders', { status: flag(flags, 'status') });
    return out(result, () => rows(result, 'reminders').map(reminderLine).join('\n') || 'None.');
  }

  if (sub === 'done') {
    const id = rest[0];
    if (!id) throw new Error(CRM_USAGE);
    if (!client.patch) throw new Error('this client cannot edit');
    const result = await client.patch(`/crm/reminders/${encodeURIComponent(id)}`, {
      done: flags.undo !== true,
    });
    return out(result, () => (flags.undo === true ? 'Reopened.' : 'Done.'));
  }

  throw new Error(CRM_USAGE);
}

const DAY_RANGE = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** "mon-fri=09:00-17:00;sat=10:00-12:00" → weekly availability. */
export function parseHours(spec: string): Record<string, { start: string; end: string }[]> {
  const out: Record<string, { start: string; end: string }[]> = {};
  for (const part of spec.split(/[;\s]+/).filter(Boolean)) {
    const [days, times] = part.split('=');
    if (!days || !times) throw new Error(`--hours: expected day=HH:MM-HH:MM, got "${part}"`);
    const [start, end] = times.split('-');
    if (!start || !end) throw new Error(`--hours: expected HH:MM-HH:MM in "${part}"`);
    const [from, to] = days.toLowerCase().split('-');
    const first = DAY_RANGE.indexOf(from?.slice(0, 3) ?? '');
    const last = to ? DAY_RANGE.indexOf(to.slice(0, 3)) : first;
    if (first < 0 || last < 0) throw new Error(`--hours: unknown day in "${part}"`);
    for (let i = first; ; i = (i + 1) % 7) {
      const day = DAY_RANGE[i]!;
      (out[day] ??= []).push({ start, end });
      if (i === last) break;
    }
  }
  return out;
}

async function runCal({ client, args, flags }: CommandContext): Promise<string> {
  const [sub, ...rest] = args;
  const json = flags.json === true;
  const out = (value: unknown, render: () => string) =>
    json ? JSON.stringify(value, null, 2) : render();

  const pageText = (result: Rec) => {
    const page = result.page as Rec | null;
    if (!page) return 'No booking page yet. Make one: og cal set --handle <name>';
    return [
      `${text(result, 'url')}${page.active ? '' : '  (off)'}`,
      `${text(page, 'title')}, ${text(page, 'durationMinutes')} min, ${text(page, 'timezone')}, ${text(page, 'minNoticeMinutes')} min notice, ${text(page, 'maxDaysAhead')} days ahead`,
      `hours: ${JSON.stringify(page.availability)}`,
      'Every booking is a private PairUX call and lands in og crm.',
    ].join('\n');
  };

  if (!sub) {
    const result = (await client.get('/calendar/page')) as Rec;
    return out(result, () => pageText(result));
  }

  if (sub === 'set') {
    const body: Rec = {};
    if (flag(flags, 'handle')) body.handle = flag(flags, 'handle');
    if (flag(flags, 'title')) body.title = flag(flags, 'title');
    if (flag(flags, 'description')) body.description = flag(flags, 'description');
    if (flag(flags, 'name')) body.hostName = flag(flags, 'name');
    if (flag(flags, 'minutes')) body.durationMinutes = Number(flag(flags, 'minutes'));
    if (flag(flags, 'tz')) body.timezone = flag(flags, 'tz');
    if (flag(flags, 'hours')) body.availability = parseHours(flag(flags, 'hours')!);
    if (flag(flags, 'notice')) body.minNoticeMinutes = Number(flag(flags, 'notice'));
    if (flag(flags, 'ahead')) body.maxDaysAhead = Number(flag(flags, 'ahead'));
    if (flag(flags, 'buffer')) body.bufferMinutes = Number(flag(flags, 'buffer'));
    if (flags.on === true) body.active = true;
    if (flags.off === true) body.active = false;
    const result = (await client.put('/calendar/page', body)) as Rec;
    return out(result, () => pageText(result));
  }

  if (sub === 'bookings') {
    const scope = flags.past === true ? 'past' : flags.all === true ? 'all' : 'upcoming';
    const result = await client.get('/calendar/bookings', { scope });
    return out(result, () => rows(result, 'bookings').map(bookingLine).join('\n') || 'None.');
  }

  if (sub === 'cancel') {
    const id = rest[0];
    if (!id) throw new Error(CAL_USAGE);
    const result = await client.post(`/calendar/bookings/${encodeURIComponent(id)}/cancel`);
    return out(result, () => 'Cancelled; the guest was emailed a link to rebook.');
  }

  throw new Error(CAL_USAGE);
}

export const CRM_COMMANDS: readonly Command[] = [
  {
    name: 'crm',
    usage: CRM_USAGE,
    summary: 'CRM: deals by stage, call notes, reminders, and what needs doing next.',
    run: runCrm,
  },
  {
    name: 'cal',
    usage: CAL_USAGE,
    summary:
      'Your public booking page (outreachgraph.com/calendar/<handle>): PairUX calls that land in the CRM.',
    run: runCal,
  },
];

import { afterEach, describe, expect, test } from 'bun:test';
import { queryAll, queryOne } from '@outreachgraph/db';
import type { Mailer, Message } from '@outreachgraph/email';
import { createApp } from './app';
import type { RequestActor } from './context';
import { sendDueCrmMail } from './crm';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';

process.env.CROSS_PROMO = 'bundled';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

const OWNER: RequestActor = {
  userId: SEED.userId,
  workspaceId: SEED.workspaceId,
  organizationId: SEED.organizationId,
  role: 'owner',
};

const VIEWER: RequestActor = { ...OWNER, role: 'viewer' };

interface Reply {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

class RecordingMailer implements Mailer {
  readonly sent: Message[] = [];
  async send(message: Message) {
    this.sent.push(message);
    return {};
  }
}

async function harness(label: string) {
  seeded = await seedDatabase(label);
  const db = seeded.db;
  const mailer = new RecordingMailer();
  let current: RequestActor = OWNER;
  const app = createApp({
    db,
    mailer,
    appUrl: 'https://og.test',
    authenticate: async () => current,
  });

  const call = async (
    method: string,
    path: string,
    body?: unknown,
    actor: RequestActor = OWNER,
  ): Promise<Reply> => {
    current = actor;
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.9' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // .ics and other text bodies
    }
    return { status: res.status, body: parsed };
  };

  return { db, call, mailer };
}

/** Every day, all day, in UTC: any future half hour is offerable. */
const ALWAYS = Object.fromEntries(
  ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [
    d,
    [{ start: '00:00', end: '24:00' }],
  ]),
);

describe('crm deals', () => {
  test('create, move through stages, log a call, and read the summary', async () => {
    const { call } = await harness('crm-deals');

    const created = await call('POST', '/crm/deals', {
      contactName: 'Grace Hopper',
      contactEmail: 'Grace@Navy.mil',
      company: 'Navy',
      value: 1200,
      note: 'Met at the conference.',
    });
    expect(created.status).toBe(201);
    const deal = created.body.deal;
    expect(deal.title).toBe('Grace Hopper · Navy');
    expect(deal.contactEmail).toBe('grace@navy.mil');
    expect(deal.stage).toBe('lead');
    expect(deal.valueCents).toBe(120_000);
    expect(created.body.activities[0].body).toBe('Met at the conference.');

    const moved = await call('PATCH', `/crm/deals/${deal.id}`, {
      stage: 'proposal',
      nextStep: 'Send the quote',
    });
    expect(moved.status).toBe(200);
    expect(moved.body.deal.stage).toBe('proposal');
    expect(moved.body.activities.some((a: { kind: string }) => a.kind === 'stage')).toBe(true);

    const logged = await call('POST', `/crm/deals/${deal.id}/activities`, {
      kind: 'call',
      body: 'Wants a pilot in January.',
      durationMinutes: 25,
    });
    expect(logged.status).toBe(201);
    expect(logged.body.activity.durationMinutes).toBe(25);

    const won = await call('PATCH', `/crm/deals/${deal.id}`, { stage: 'won' });
    expect(won.body.deal.closedAt).not.toBeNull();

    const summary = await call('GET', '/crm/summary');
    const wonStage = summary.body.stages.find((s: { stage: string }) => s.stage === 'won');
    expect(wonStage.deals).toBe(1);
    expect(wonStage.valueCents).toBe(120_000);

    const found = await call('GET', '/crm/deals?q=hopper');
    expect(found.body.deals).toHaveLength(1);
    const byEmail = await call('GET', '/crm/deals?email=grace@navy.mil');
    expect(byEmail.body.deals).toHaveLength(1);
  });

  test('refuses bad input and viewers', async () => {
    const { call } = await harness('crm-refusals');
    expect((await call('POST', '/crm/deals', {})).status).toBe(400);
    expect((await call('POST', '/crm/deals', { title: 'x', stage: 'closed' })).status).toBe(400);
    expect((await call('POST', '/crm/deals', { title: 'x', contactEmail: 'nope' })).status).toBe(
      400,
    );
    expect((await call('POST', '/crm/deals', { title: 'x' }, VIEWER)).status).toBe(403);
    expect((await call('GET', '/crm/deals', undefined, VIEWER)).status).toBe(200);
    expect((await call('GET', '/crm/deals/dea_missing')).status).toBe(404);
  });

  test('reminders: due ones are mailed once, done ones close', async () => {
    const { db, call } = await harness('crm-reminders');
    const deal = (await call('POST', '/crm/deals', { title: 'Acme' })).body.deal;
    const past = new Date(Date.now() - 60_000).toISOString();
    const made = await call('POST', '/crm/reminders', {
      title: 'Follow up',
      dueAt: past,
      dealId: deal.id,
    });
    expect(made.status).toBe(201);

    const due = await call('GET', '/crm/summary');
    expect(due.body.dueReminders).toHaveLength(1);

    const mailer = new RecordingMailer();
    expect(await sendDueCrmMail(db, { mailer, appUrl: 'https://og.test' })).toEqual({
      reminders: 1,
      bookings: 0,
    });
    expect(mailer.sent[0]?.to).toBe('test@example.com');
    expect(mailer.sent[0]?.subject).toBe('Reminder: Follow up');
    // Already sent: a second tick sends nothing.
    expect((await sendDueCrmMail(db, { mailer })).reminders).toBe(0);

    const done = await call('PATCH', `/crm/reminders/${made.body.reminder.id}`, { done: true });
    expect(done.body.reminder.doneAt).not.toBeNull();
    expect((await call('GET', '/crm/reminders')).body.reminders).toHaveLength(0);
    expect((await call('GET', '/crm/reminders?status=done')).body.reminders).toHaveLength(1);
  });
});

describe('booking page', () => {
  test('a guest books a PairUX call, which lands in the CRM and can be cancelled', async () => {
    const { db, call, mailer } = await harness('calendar-book');

    expect((await call('GET', '/calendar/page')).body.page).toBeNull();
    const saved = await call('PUT', '/calendar/page', {
      handle: 'Chovy',
      title: 'Intro call',
      hostName: 'Anthony',
      timezone: 'UTC',
      durationMinutes: 30,
      availability: ALWAYS,
      minNoticeMinutes: 0,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.url).toBe('https://og.test/calendar/chovy');

    const pub = await call('GET', '/public/calendar/chovy');
    expect(pub.status).toBe(200);
    expect(pub.body.page).toMatchObject({
      handle: 'chovy',
      title: 'Intro call',
      hostName: 'Anthony',
    });
    expect(pub.body.page.userId).toBeUndefined();

    const slots = await call('GET', '/public/calendar/chovy/slots?days=3');
    expect(slots.status).toBe(200);
    const slot = slots.body.slots[2];
    expect(slot).toBeDefined();

    const booked = await call('POST', '/public/calendar/chovy/book', {
      start: slot.start,
      name: 'Ada Lovelace',
      email: 'ada@example.org',
      note: 'About the engine',
      timezone: 'Europe/London',
    });
    expect(booked.status).toBe(201);
    expect(booked.body.booking.meetingUrl).toMatch(
      /^https:\/\/pairux\.com\/r\/[A-Za-z0-9_-]{22}#k=[A-Za-z0-9_-]{43}$/,
    );
    const manage = new URL(booked.body.booking.manageUrl);
    const token = manage.searchParams.get('token');
    expect(manage.pathname).toBe(`/calendar/chovy/booking/${booked.body.booking.id}`);

    // The same slot cannot be taken twice.
    const again = await call('POST', '/public/calendar/chovy/book', {
      start: slot.start,
      name: 'Someone',
      email: 'someone@example.org',
    });
    expect(again.status).toBe(409);

    // It is gone from the offer.
    const after = await call('GET', '/public/calendar/chovy/slots?days=3');
    expect(after.body.slots.some((s: { start: string }) => s.start === slot.start)).toBe(false);

    // In the CRM: a deal at `meeting`, a meeting activity and a notes reminder.
    const deals = (await call('GET', '/crm/deals?email=ada@example.org')).body.deals;
    expect(deals).toHaveLength(1);
    expect(deals[0].stage).toBe('meeting');
    expect(deals[0].source).toBe('booking');
    const detail = (await call('GET', `/crm/deals/${deals[0].id}`)).body;
    expect(detail.activities.some((a: { kind: string }) => a.kind === 'meeting')).toBe(true);
    expect(detail.reminders[0].title).toBe('Write call notes for Ada Lovelace');
    expect(detail.bookings).toHaveLength(1);

    // Mail: confirmation to both sides, guest's with the room link.
    const guestMail = mailer.sent.find((m) => m.to === 'ada@example.org');
    const hostMail = mailer.sent.find((m) => m.to === 'test@example.com');
    expect(guestMail?.text).toContain(booked.body.booking.meetingUrl);
    expect(guestMail?.replyTo).toBe('test@example.com');
    expect(hostMail?.replyTo).toBe('ada@example.org');

    // The token unlocks the booking and its calendar file; a wrong one does not.
    const id = booked.body.booking.id;
    expect((await call('GET', `/public/calendar/bookings/${id}?token=${token}`)).status).toBe(200);
    expect((await call('GET', `/public/calendar/bookings/${id}?token=wrong`)).status).toBe(404);
    const ics = await call('GET', `/public/calendar/bookings/${id}/ics?token=${token}`);
    expect(ics.status).toBe(200);
    expect(String(ics.body)).toContain('BEGIN:VEVENT');

    // Upcoming in the host's list.
    expect((await call('GET', '/calendar/bookings')).body.bookings).toHaveLength(1);

    // The guest cancels; the slot comes back and the notes reminder goes.
    const cancelled = await call('POST', `/public/calendar/bookings/${id}/cancel?token=${token}`);
    expect(cancelled.status).toBe(200);
    expect(
      (await call('POST', `/public/calendar/bookings/${id}/cancel?token=${token}`)).status,
    ).toBe(409);
    const reopened = await call('GET', '/public/calendar/chovy/slots?days=3');
    expect(reopened.body.slots.some((s: { start: string }) => s.start === slot.start)).toBe(true);
    const reminders = await queryAll(db, 'SELECT id FROM crm_reminders WHERE booking_id = ?', [id]);
    expect(reminders).toHaveLength(0);
  });

  test('handles are unique, validated, and an inactive page is not public', async () => {
    const { db, call } = await harness('calendar-handles');
    expect((await call('PUT', '/calendar/page', { handle: 'api' })).status).toBe(400);
    expect((await call('PUT', '/calendar/page', { handle: 'x y' })).status).toBe(400);
    expect(
      (await call('PUT', '/calendar/page', { handle: 'ok-handle', timezone: 'Mars/Base' })).status,
    ).toBe(400);
    expect(
      (await call('PUT', '/calendar/page', { handle: 'ok-handle', durationMinutes: 17 })).status,
    ).toBe(400);
    expect((await call('PUT', '/calendar/page', { handle: 'ok-handle' })).status).toBe(200);

    const stamp = new Date().toISOString();
    await db
      .execute({
        sql: `INSERT INTO booking_pages (id, workspace_id, user_id, handle, title, timezone,
              availability, created_at, updated_at)
            VALUES ('bkp_other', ?, ?, 'taken', 't', 'UTC', '{}', ?, ?)`,
        args: [SEED.workspaceId, 'usr_other', stamp, stamp],
      })
      .catch(() => undefined);
    const other = await queryOne(db, "SELECT id FROM booking_pages WHERE handle = 'taken'");
    if (other) expect((await call('PUT', '/calendar/page', { handle: 'taken' })).status).toBe(409);

    expect((await call('PUT', '/calendar/page', { active: false })).status).toBe(200);
    expect((await call('GET', '/public/calendar/ok-handle')).status).toBe(404);
    expect((await call('GET', '/public/calendar/nobody')).status).toBe(404);
  });

  test('refuses a slot the page does not offer and a bad guest', async () => {
    const { call } = await harness('calendar-refusals');
    await call('PUT', '/calendar/page', {
      handle: 'chovy',
      timezone: 'UTC',
      availability: ALWAYS,
      minNoticeMinutes: 0,
    });
    const slot = (await call('GET', '/public/calendar/chovy/slots?days=2')).body.slots[1];
    const offset = new Date(Date.parse(slot.start) + 7 * 60_000).toISOString();
    expect(
      (
        await call('POST', '/public/calendar/chovy/book', {
          start: offset,
          name: 'A',
          email: 'a@example.org',
        })
      ).status,
    ).toBe(409);
    expect(
      (await call('POST', '/public/calendar/chovy/book', { start: slot.start, name: 'A' })).status,
    ).toBe(400);
  });

  test('an hour before, both sides get a reminder, once', async () => {
    const { db, call } = await harness('calendar-soon');
    await call('PUT', '/calendar/page', {
      handle: 'chovy',
      timezone: 'UTC',
      availability: ALWAYS,
      minNoticeMinutes: 0,
    });
    const slot = (await call('GET', '/public/calendar/chovy/slots?days=2')).body.slots[1];
    await call('POST', '/public/calendar/chovy/book', {
      start: slot.start,
      name: 'Ada',
      email: 'ada@example.org',
    });
    const mailer = new RecordingMailer();
    const justBefore = new Date(Date.parse(slot.start) - 30 * 60_000);
    expect((await sendDueCrmMail(db, { mailer, now: justBefore })).bookings).toBe(1);
    expect(mailer.sent.map((m) => m.to).sort()).toEqual(['ada@example.org', 'test@example.com']);
    expect((await sendDueCrmMail(db, { mailer, now: justBefore })).bookings).toBe(0);
  });
});

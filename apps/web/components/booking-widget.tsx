'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * The guest's side of /calendar/<handle>: pick a time, give a name and an
 * email, get a PairUX link.
 *
 * Slots come from the public API as instants. They are fetched a week at a
 * time by the page's own calendar date and regrouped by the date the guest
 * sees in their own zone, so a slot is always shown in local time.
 */

interface Slot {
  readonly start: string;
  readonly end: string;
}

interface Booked {
  readonly id: string;
  readonly startsAt: string;
  readonly meetingUrl: string;
  readonly manageUrl: string;
  readonly icsUrl: string;
}

interface Props {
  readonly handle: string;
  readonly hostName: string;
  readonly title: string;
  readonly durationMinutes: number;
  readonly pageTimezone: string;
  readonly maxDaysAhead: number;
}

const DAY_MS = 86_400_000;

/** "YYYY-MM-DD" for an instant as seen in a zone. */
function ymd(ms: number, zone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days));
  return next.toISOString().slice(0, 10);
}

export function BookingWidget(props: Props) {
  const guestZone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  }, []);
  const today = useMemo(() => ymd(Date.now(), props.pageTimezone), [props.pageTimezone]);
  const lastDay = useMemo(
    () => ymd(Date.now() + props.maxDaysAhead * DAY_MS, props.pageTimezone),
    [props.maxDaysAhead, props.pageTimezone],
  );

  const [from, setFrom] = useState(today);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Slot | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [booked, setBooked] = useState<Booked | null>(null);

  const load = useCallback(async () => {
    setSlots(null);
    setLoadError(null);
    try {
      const response = await fetch(
        `/api/v1/public/calendar/${encodeURIComponent(props.handle)}/slots?from=${from}&days=7`,
        { cache: 'no-store' },
      );
      if (!response.ok) throw new Error(String(response.status));
      const body = (await response.json()) as { slots: Slot[] };
      setSlots(body.slots);
    } catch {
      setLoadError('Could not load times. Refresh to try again.');
    }
  }, [from, props.handle]);

  useEffect(() => {
    void load();
  }, [load]);

  const days = useMemo(() => {
    const groups = new Map<string, Slot[]>();
    for (const slot of slots ?? []) {
      const key = ymd(Date.parse(slot.start), guestZone);
      const list = groups.get(key) ?? [];
      list.push(slot);
      groups.set(key, list);
    }
    return [...groups.entries()];
  }, [slots, guestZone]);

  const dayLabel = (date: string) =>
    new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${date}T12:00:00Z`));

  const timeLabel = (iso: string) =>
    new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: guestZone,
    }).format(new Date(iso));

  const longLabel = (iso: string) =>
    new Intl.DateTimeFormat(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: guestZone,
      timeZoneName: 'short',
    }).format(new Date(iso));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/v1/public/calendar/${encodeURIComponent(props.handle)}/book`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ start: chosen.start, name, email, note, timezone: guestZone }),
        },
      );
      const body = (await response.json().catch(() => ({}))) as {
        booking?: Booked;
        error?: { message?: string };
        message?: string;
      };
      if (!response.ok || !body.booking) {
        setError(body.error?.message ?? body.message ?? 'That did not work. Try another time.');
        if (response.status === 409) {
          setChosen(null);
          void load();
        }
        return;
      }
      setBooked(body.booking);
    } catch {
      setError('Could not reach the server. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (booked) {
    return (
      <div className="border-border rounded-2xl border p-6">
        <p className="text-good text-sm font-medium">Booked</p>
        <h2 className="mt-1 text-lg font-semibold">{longLabel(booked.startsAt)}</h2>
        <p className="text-ink-muted mt-2 text-sm">
          {props.title} with {props.hostName}. A confirmation is on its way to {email}.
        </p>
        <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          <a
            href={booked.meetingUrl}
            className="bg-accent rounded-xl px-4 py-2.5 text-center text-sm font-medium text-white"
          >
            PairUX call link
          </a>
          <a
            href={booked.icsUrl}
            className="border-border rounded-xl border px-4 py-2.5 text-center text-sm"
          >
            Add to calendar
          </a>
          <a
            href={booked.manageUrl}
            className="border-border rounded-xl border px-4 py-2.5 text-center text-sm"
          >
            Reschedule or cancel
          </a>
        </div>
        <p className="text-ink-muted mt-4 text-xs">
          Keep the call link: it is the room, and it is end-to-end encrypted. It runs in your
          browser; nothing to install.
        </p>
      </div>
    );
  }

  if (chosen) {
    return (
      <form onSubmit={(e) => void submit(e)} className="border-border rounded-2xl border p-6">
        <button
          type="button"
          onClick={() => setChosen(null)}
          className="text-ink-muted text-sm underline"
        >
          ← Pick another time
        </button>
        <h2 className="mt-3 text-lg font-semibold">{longLabel(chosen.start)}</h2>
        <p className="text-ink-muted text-sm">
          {String(props.durationMinutes)} minutes · PairUX video call
        </p>
        <label className="mt-5 block text-sm">
          Your name
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
            autoComplete="name"
            className="border-border bg-surface mt-1 block w-full rounded-xl border px-3 py-2"
          />
        </label>
        <label className="mt-3 block text-sm">
          Email
          <input
            required
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            maxLength={320}
            autoComplete="email"
            className="border-border bg-surface mt-1 block w-full rounded-xl border px-3 py-2"
          />
        </label>
        <label className="mt-3 block text-sm">
          What would you like to talk about? <span className="text-ink-muted">(optional)</span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={2000}
            rows={3}
            className="border-border bg-surface mt-1 block w-full rounded-xl border px-3 py-2"
          />
        </label>
        {error ? <p className="text-hot mt-3 text-sm">{error}</p> : null}
        <button
          type="submit"
          disabled={busy}
          className="bg-accent mt-5 w-full rounded-xl px-4 py-2.5 text-sm font-medium text-white disabled:opacity-60"
        >
          {busy ? 'Booking…' : 'Book the call'}
        </button>
      </form>
    );
  }

  return (
    <div className="border-border rounded-2xl border p-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between gap-2">
        <button
          type="button"
          disabled={from <= today}
          onClick={() => setFrom(addDays(from, -7))}
          className="border-border rounded-lg border px-3 py-1.5 text-sm disabled:opacity-40"
        >
          ← Earlier
        </button>
        <p className="text-ink-muted text-center text-xs">Times in {guestZone}</p>
        <button
          type="button"
          disabled={addDays(from, 7) > lastDay}
          onClick={() => setFrom(addDays(from, 7))}
          className="border-border rounded-lg border px-3 py-1.5 text-sm disabled:opacity-40"
        >
          Later →
        </button>
      </div>
      {loadError ? (
        <p className="text-hot text-sm">{loadError}</p>
      ) : slots === null ? (
        <p className="text-ink-muted text-sm">Loading times…</p>
      ) : days.length === 0 ? (
        <p className="text-ink-muted text-sm">No open times this week. Try later.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {days.map(([date, list]) => (
            <section key={date}>
              <h3 className="mb-2 text-sm font-semibold">{dayLabel(date)}</h3>
              <div className="flex flex-wrap gap-2">
                {list.map((slot) => (
                  <button
                    key={slot.start}
                    type="button"
                    onClick={() => setChosen(slot)}
                    className="border-accent text-accent hover:bg-accent rounded-lg border px-3 py-1.5 text-sm hover:text-white"
                  >
                    {timeLabel(slot.start)}
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

/** The guest's cancel button on the manage page. */
export function CancelBooking({ id, token }: { readonly id: string; readonly token: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  async function cancel() {
    if (!window.confirm('Cancel this call?')) return;
    setState('busy');
    try {
      const response = await fetch(
        `/api/v1/public/calendar/bookings/${encodeURIComponent(id)}/cancel?token=${encodeURIComponent(token)}`,
        { method: 'POST' },
      );
      setState(response.ok ? 'done' : 'error');
    } catch {
      setState('error');
    }
  }
  if (state === 'done')
    return <p className="text-good text-sm">Cancelled. The host has been told.</p>;
  return (
    <div>
      <button
        type="button"
        disabled={state === 'busy'}
        onClick={() => void cancel()}
        className="border-hot text-hot rounded-xl border px-4 py-2.5 text-sm disabled:opacity-60"
      >
        {state === 'busy' ? 'Cancelling…' : 'Cancel this call'}
      </button>
      {state === 'error' ? <p className="text-hot mt-2 text-sm">That did not work.</p> : null}
    </div>
  );
}

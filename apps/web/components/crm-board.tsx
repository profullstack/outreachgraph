'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  BookingPageView,
  CrmReminderView,
  CrmStageView,
  CrmSummaryView,
  DealView,
} from '../lib/api';

/**
 * The CRM tab: what needs doing, the pipeline, one deal's timeline, and the
 * booking page. Everything goes through /api/v1/crm and /api/v1/calendar, the
 * same endpoints the CLI (`og crm`, `og cal`) and the MCP tools use.
 */

const STAGES: readonly CrmStageView[] = [
  'lead',
  'contacted',
  'replied',
  'meeting',
  'proposal',
  'won',
  'lost',
];

const input = 'border-border bg-surface mt-1 block w-full rounded-xl border px-3 py-2 text-sm';
const button = 'bg-accent rounded-xl px-4 py-2 text-sm font-medium text-white disabled:opacity-60';
const quiet = 'border-border rounded-xl border px-3 py-1.5 text-sm';

function money(cents: number | null | undefined): string {
  return cents ? `$${(cents / 100).toLocaleString()}` : '';
}

function when(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message ?? `request failed (${response.status})`);
  return body;
}

interface DealDetail {
  deal: DealView;
  activities: {
    id: string;
    kind: string;
    body: string;
    occurredAt: string;
    durationMinutes: number | null;
  }[];
  reminders: CrmReminderView[];
  bookings: { id: string; startsAt: string; meetingUrl: string; status: string }[];
}

export function CrmBoard(props: {
  readonly initialSummary: CrmSummaryView;
  readonly initialDeals: readonly DealView[];
  readonly initialPage: BookingPageView | null;
  readonly initialPageUrl: string | null;
  readonly initialDealId?: string;
}) {
  const [summary, setSummary] = useState(props.initialSummary);
  const [deals, setDeals] = useState<readonly DealView[]>(props.initialDeals);
  const [stage, setStage] = useState<CrmStageView | 'open' | 'all'>('open');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(props.initialDealId ?? null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, d] = await Promise.all([
        api<CrmSummaryView>('/crm/summary'),
        api<{ deals: DealView[] }>('/crm/deals?limit=500'),
      ]);
      setSummary(s);
      setDeals(d.deals);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return deals.filter((deal) => {
      if (stage === 'open' && (deal.stage === 'won' || deal.stage === 'lost')) return false;
      if (stage !== 'open' && stage !== 'all' && deal.stage !== stage) return false;
      if (!q) return true;
      return [deal.title, deal.contactName, deal.contactEmail, deal.company]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });
  }, [deals, stage, query]);

  return (
    <div className="space-y-6">
      {error ? <p className="text-hot text-sm">{error}</p> : null}

      <section aria-label="Pipeline" className="flex flex-wrap gap-2">
        {summary.stages.map((s) => (
          <button
            key={s.stage}
            type="button"
            onClick={() => setStage(s.stage)}
            className={`rounded-xl border px-3 py-2 text-left text-xs ${
              stage === s.stage ? 'border-accent' : 'border-border'
            }`}
          >
            <span className="block font-medium capitalize">{s.stage}</span>
            <span className="text-ink-muted">
              {String(s.deals)}
              {s.valueCents ? ` · ${money(s.valueCents)}` : ''}
            </span>
          </button>
        ))}
      </section>

      <TodayPanel summary={summary} onOpen={setSelected} onChanged={refresh} />

      {selected ? (
        <DealPanel id={selected} onClose={() => setSelected(null)} onChanged={refresh} />
      ) : null}

      <section aria-label="Deals">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="mr-auto text-lg font-semibold">Deals</h2>
          <select
            value={stage}
            onChange={(e) => setStage(e.target.value as typeof stage)}
            className="border-border bg-surface rounded-xl border px-2 py-1.5 text-sm"
            aria-label="Stage"
          >
            <option value="open">Open</option>
            <option value="all">All</option>
            {STAGES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            aria-label="Search deals"
            className="border-border bg-surface w-36 rounded-xl border px-3 py-1.5 text-sm"
          />
          <button type="button" className={button} onClick={() => setAdding((v) => !v)}>
            {adding ? 'Close' : 'Add deal'}
          </button>
        </div>
        {adding ? (
          <AddDeal
            onAdded={(id) => {
              setAdding(false);
              setSelected(id);
              void refresh();
            }}
          />
        ) : null}
        {visible.length === 0 ? (
          <p className="border-border text-ink-muted rounded-2xl border border-dashed p-6 text-center text-sm">
            No deals here yet. Add one, or share your booking link: every booked call lands here.
          </p>
        ) : (
          <ul className="divide-border border-border divide-y rounded-2xl border">
            {visible.map((deal) => (
              <li key={deal.id}>
                <button
                  type="button"
                  onClick={() => setSelected(deal.id)}
                  className="hover:bg-surface-raised block w-full px-4 py-3 text-left"
                >
                  <span className="flex items-baseline gap-2">
                    <span className="truncate font-medium">{deal.title}</span>
                    <span className="text-ink-muted text-xs capitalize">{deal.stage}</span>
                    <span className="ml-auto text-xs">{money(deal.valueCents)}</span>
                  </span>
                  <span className="text-ink-muted block truncate text-xs">
                    {[deal.contactEmail, deal.nextStep && `next: ${deal.nextStep}`]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <BookingPageSettings initial={props.initialPage} initialUrl={props.initialPageUrl} />
    </div>
  );
}

function TodayPanel({
  summary,
  onOpen,
  onChanged,
}: {
  summary: CrmSummaryView;
  onOpen: (id: string) => void;
  onChanged: () => Promise<void>;
}) {
  const nothing =
    summary.dueReminders.length === 0 &&
    summary.upcomingBookings.length === 0 &&
    summary.staleDeals.length === 0;
  if (nothing) return null;
  return (
    <section aria-label="Today" className="border-border rounded-2xl border p-4">
      <h2 className="mb-2 text-lg font-semibold">Needs doing</h2>
      {summary.dueReminders.length ? (
        <ul className="mb-3 space-y-1">
          {summary.dueReminders.map((r) => (
            <li key={r.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                aria-label={`Done: ${r.title}`}
                onChange={() =>
                  void api(`/crm/reminders/${r.id}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ done: true }),
                  }).then(onChanged)
                }
              />
              <span className="text-ink-muted w-28 shrink-0 text-xs">{when(r.dueAt)}</span>
              <button
                type="button"
                className="truncate text-left"
                onClick={() => r.dealId && onOpen(r.dealId)}
              >
                {r.title}
                {r.dealTitle ? <span className="text-ink-muted"> · {r.dealTitle}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {summary.upcomingBookings.length ? (
        <>
          <h3 className="text-ink-muted mt-2 mb-1 text-xs font-medium uppercase">Calls</h3>
          <ul className="mb-3 space-y-1">
            {summary.upcomingBookings.map((b) => (
              <li key={b.id} className="flex items-center gap-2 text-sm">
                <span className="text-ink-muted w-28 shrink-0 text-xs">{when(b.startsAt)}</span>
                <button
                  type="button"
                  className="truncate text-left"
                  onClick={() => b.dealId && onOpen(b.dealId)}
                >
                  {b.guestName}
                </button>
                <a href={b.meetingUrl} className="text-accent ml-auto text-xs underline">
                  Join
                </a>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {summary.staleDeals.length ? (
        <>
          <h3 className="text-ink-muted mt-2 mb-1 text-xs font-medium uppercase">
            Quiet for two weeks
          </h3>
          <ul className="space-y-1">
            {summary.staleDeals.slice(0, 8).map((d) => (
              <li key={d.id} className="text-sm">
                <button type="button" className="text-left" onClick={() => onOpen(d.id)}>
                  {d.title} <span className="text-ink-muted text-xs capitalize">· {d.stage}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function AddDeal({ onAdded }: { onAdded: (id: string) => void }) {
  const [form, setForm] = useState({
    contactName: '',
    contactEmail: '',
    company: '',
    value: '',
    note: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(form)) if (v.trim()) body[k] = v.trim();
      if (body.value) body.value = Number(body.value);
      const result = await api<{ deal: DealView }>('/crm/deals', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      onAdded(result.deal.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="border-border mb-4 grid gap-2 rounded-2xl border p-4 sm:grid-cols-2"
    >
      <label className="text-sm">
        Name
        <input className={input} value={form.contactName} onChange={set('contactName')} />
      </label>
      <label className="text-sm">
        Email
        <input
          className={input}
          type="email"
          value={form.contactEmail}
          onChange={set('contactEmail')}
        />
      </label>
      <label className="text-sm">
        Company
        <input className={input} value={form.company} onChange={set('company')} />
      </label>
      <label className="text-sm">
        Value ($)
        <input className={input} inputMode="decimal" value={form.value} onChange={set('value')} />
      </label>
      <label className="text-sm sm:col-span-2">
        First note
        <input className={input} value={form.note} onChange={set('note')} />
      </label>
      {error ? <p className="text-hot text-sm sm:col-span-2">{error}</p> : null}
      <button type="submit" disabled={busy} className={`${button} sm:col-span-2`}>
        {busy ? 'Adding…' : 'Add deal'}
      </button>
    </form>
  );
}

function DealPanel({
  id,
  onClose,
  onChanged,
}: {
  id: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [detail, setDetail] = useState<DealDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState('call');
  const [note, setNote] = useState('');
  const [minutes, setMinutes] = useState('');
  const [reminder, setReminder] = useState('');
  const [due, setDue] = useState('');
  const [nextStep, setNextStep] = useState('');

  const load = useCallback(async () => {
    try {
      const d = await api<DealDetail>(`/crm/deals/${id}`);
      setDetail(d);
      setNextStep(d.deal.nextStep ?? '');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const after = async () => {
    await load();
    await onChanged();
  };

  async function patch(body: Record<string, unknown>) {
    setError(null);
    try {
      await api(`/crm/deals/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      await after();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function log(e: React.FormEvent) {
    e.preventDefault();
    if (!note.trim()) return;
    try {
      await api(`/crm/deals/${id}/activities`, {
        method: 'POST',
        body: JSON.stringify({
          kind,
          body: note,
          ...(minutes ? { durationMinutes: Number(minutes) } : {}),
        }),
      });
      setNote('');
      setMinutes('');
      await after();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remind(e: React.FormEvent) {
    e.preventDefault();
    if (!reminder.trim() || !due) return;
    try {
      await api('/crm/reminders', {
        method: 'POST',
        body: JSON.stringify({ title: reminder, dueAt: new Date(due).toISOString(), dealId: id }),
      });
      setReminder('');
      setDue('');
      await after();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (!detail) {
    return (
      <section className="border-border rounded-2xl border p-4 text-sm">
        {error ?? 'Loading…'}
      </section>
    );
  }
  const { deal } = detail;

  return (
    <section aria-label="Deal" className="border-accent rounded-2xl border p-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold">{deal.title}</h2>
          <p className="text-ink-muted text-xs">
            {[deal.contactName, deal.contactEmail, deal.company, money(deal.valueCents)]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <button type="button" onClick={onClose} className={`${quiet} ml-auto`}>
          Close
        </button>
      </div>
      {error ? <p className="text-hot mt-2 text-sm">{error}</p> : null}

      <div className="mt-3 flex flex-wrap gap-1">
        {STAGES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => void patch({ stage: s })}
            className={`rounded-lg border px-2 py-1 text-xs capitalize ${
              deal.stage === s ? 'border-accent bg-accent text-white' : 'border-border'
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void patch({ nextStep });
        }}
      >
        <input
          className={`${input} mt-0`}
          placeholder="Next step"
          aria-label="Next step"
          value={nextStep}
          onChange={(e) => setNextStep(e.target.value)}
        />
        <button type="submit" className={quiet}>
          Save
        </button>
      </form>

      <form onSubmit={(e) => void log(e)} className="mt-4">
        <div className="flex gap-2">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            aria-label="Kind"
            className="border-border bg-surface rounded-xl border px-2 text-sm"
          >
            <option value="call">Call notes</option>
            <option value="note">Note</option>
            <option value="meeting">Meeting</option>
            <option value="email">Email</option>
          </select>
          <input
            className="border-border bg-surface w-20 rounded-xl border px-2 text-sm"
            placeholder="min"
            aria-label="Minutes"
            inputMode="numeric"
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
          />
        </div>
        <textarea
          className={input}
          rows={3}
          placeholder="What was said, what was agreed"
          aria-label="Notes"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button type="submit" className={`${button} mt-2`}>
          Log
        </button>
      </form>

      <form onSubmit={(e) => void remind(e)} className="mt-4 flex flex-wrap gap-2">
        <input
          className="border-border bg-surface min-w-0 flex-1 rounded-xl border px-3 py-1.5 text-sm"
          placeholder="Remind me to…"
          aria-label="Reminder"
          value={reminder}
          onChange={(e) => setReminder(e.target.value)}
        />
        <input
          type="datetime-local"
          className="border-border bg-surface rounded-xl border px-2 py-1.5 text-sm"
          aria-label="Due"
          value={due}
          onChange={(e) => setDue(e.target.value)}
        />
        <button type="submit" className={quiet}>
          Set
        </button>
      </form>

      {detail.reminders.length ? (
        <ul className="mt-3 space-y-1">
          {detail.reminders.map((r) => (
            <li key={r.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={Boolean(r.doneAt)}
                aria-label={`Done: ${r.title}`}
                onChange={(e) =>
                  void api(`/crm/reminders/${r.id}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ done: e.target.checked }),
                  }).then(after)
                }
              />
              <span className={r.doneAt ? 'text-ink-muted line-through' : ''}>{r.title}</span>
              <span className="text-ink-muted ml-auto text-xs">{when(r.dueAt)}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {detail.bookings.length ? (
        <ul className="mt-3 space-y-1">
          {detail.bookings.map((b) => (
            <li key={b.id} className="flex items-center gap-2 text-sm">
              <span>Call {when(b.startsAt)}</span>
              <span className="text-ink-muted text-xs">{b.status}</span>
              {b.status === 'confirmed' ? (
                <a href={b.meetingUrl} className="text-accent ml-auto text-xs underline">
                  Join
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <ol className="border-border mt-4 space-y-3 border-t pt-3">
        {detail.activities.map((a) => (
          <li key={a.id} className="text-sm">
            <p className="text-ink-muted text-xs">
              {when(a.occurredAt)} · {a.kind}
              {a.durationMinutes ? ` · ${String(a.durationMinutes)} min` : ''}
            </p>
            <p className="whitespace-pre-line">{a.body}</p>
          </li>
        ))}
      </ol>

      <button
        type="button"
        className="text-hot mt-4 text-xs underline"
        onClick={() => {
          if (!window.confirm('Delete this deal and its timeline?')) return;
          void api(`/crm/deals/${id}`, { method: 'DELETE' }).then(async () => {
            onClose();
            await onChanged();
          });
        }}
      >
        Delete deal
      </button>
    </section>
  );
}

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

function BookingPageSettings({
  initial,
  initialUrl,
}: {
  initial: BookingPageView | null;
  initialUrl: string | null;
}) {
  const guessZone = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return 'UTC';
    }
  })();
  const firstWindow = initial
    ? Object.values(initial.availability).find((w) => w.length)?.[0]
    : undefined;
  const [handle, setHandle] = useState(initial?.handle ?? '');
  const [title, setTitle] = useState(initial?.title ?? 'Intro call');
  const [hostName, setHostName] = useState(initial?.hostName ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [duration, setDuration] = useState(String(initial?.durationMinutes ?? 30));
  const [timezone, setTimezone] = useState(initial?.timezone ?? guessZone);
  const [days, setDays] = useState<string[]>(
    initial
      ? WEEKDAYS.filter((d) => (initial.availability[d] ?? []).length > 0)
      : ['mon', 'tue', 'wed', 'thu', 'fri'],
  );
  const [start, setStart] = useState(firstWindow?.start ?? '09:00');
  const [end, setEnd] = useState(firstWindow?.end ?? '17:00');
  const [notice, setNotice] = useState(String(initial?.minNoticeMinutes ?? 240));
  const [active, setActive] = useState(initial?.active ?? true);
  const [url, setUrl] = useState(initialUrl);
  const [state, setState] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setState('Saving…');
    try {
      const availability = Object.fromEntries(days.map((d) => [d, [{ start, end }]]));
      const result = await api<{ url: string }>('/calendar/page', {
        method: 'PUT',
        body: JSON.stringify({
          handle,
          title,
          hostName,
          description,
          durationMinutes: Number(duration),
          timezone,
          availability,
          minNoticeMinutes: Number(notice),
          active,
        }),
      });
      setUrl(result.url);
      setState('Saved.');
    } catch (err) {
      setState((err as Error).message);
    }
  }

  return (
    <section aria-label="Booking page" className="border-border rounded-2xl border p-4">
      <h2 className="text-lg font-semibold">Booking page</h2>
      <p className="text-ink-muted text-sm">
        A public page where anyone can book a PairUX video call with you. Each booking becomes a
        deal here, with a reminder to write call notes.
      </p>
      {url ? (
        <p className="mt-2 text-sm">
          <a href={url} className="text-accent break-all underline">
            {url}
          </a>
        </p>
      ) : null}
      <form onSubmit={(e) => void save(e)} className="mt-3 grid gap-2 sm:grid-cols-2">
        <label className="text-sm">
          Handle
          <input
            className={input}
            required
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
          />
        </label>
        <label className="text-sm">
          Your name
          <input className={input} value={hostName} onChange={(e) => setHostName(e.target.value)} />
        </label>
        <label className="text-sm">
          Title
          <input className={input} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="text-sm">
          Length
          <select className={input} value={duration} onChange={(e) => setDuration(e.target.value)}>
            {[15, 20, 30, 45, 60, 90].map((m) => (
              <option key={m} value={m}>
                {m} minutes
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm sm:col-span-2">
          Description
          <textarea
            className={input}
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <fieldset className="text-sm sm:col-span-2">
          <legend>Days</legend>
          <div className="mt-1 flex flex-wrap gap-1">
            {WEEKDAYS.map((d) => (
              <label
                key={d}
                className={`cursor-pointer rounded-lg border px-2 py-1 text-xs capitalize ${
                  days.includes(d) ? 'border-accent' : 'border-border'
                }`}
              >
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={days.includes(d)}
                  onChange={(e) =>
                    setDays((list) =>
                      e.target.checked ? [...list, d] : list.filter((x) => x !== d),
                    )
                  }
                />
                {d}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="text-sm">
          From
          <input
            className={input}
            type="time"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>
        <label className="text-sm">
          Until
          <input
            className={input}
            type="time"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </label>
        <label className="text-sm">
          Time zone
          <input className={input} value={timezone} onChange={(e) => setTimezone(e.target.value)} />
        </label>
        <label className="text-sm">
          Minimum notice (minutes)
          <input
            className={input}
            inputMode="numeric"
            value={notice}
            onChange={(e) => setNotice(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Page is live
        </label>
        <div className="flex items-center gap-3 sm:col-span-2">
          <button type="submit" className={button}>
            Save booking page
          </button>
          {state ? <span className="text-ink-muted text-sm">{state}</span> : null}
        </div>
      </form>
    </section>
  );
}

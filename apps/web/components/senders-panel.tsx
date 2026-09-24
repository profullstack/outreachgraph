'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { SenderView } from '../lib/api';

/**
 * Every account the workspace sends from, and what each may send today.
 *
 * Connecting a second mailbox, LinkedIn session or X account adds it to a
 * pool rather than replacing the first, and sending is spread across the
 * pool. That makes two numbers worth a glance that never were before: how
 * much of today's allowance each account has used, and how far a new
 * account is through its warm-up — the slow ramp that keeps a fresh identity
 * from looking like a purchased one.
 *
 * The controls are the few a human needs when something looks wrong: pause
 * an account, resume one the product stopped (a rejected login, too many
 * bounces), set its cap, and switch warm-up off for an account that has been
 * sending by hand for years.
 */
export function SendersPanel({ initial }: { initial: readonly SenderView[] }) {
  if (initial.length === 0) {
    return (
      <section className="border-border bg-surface-raised rounded-2xl border p-4">
        <h2 className="text-sm font-semibold">Sending accounts</h2>
        <p className="text-ink-muted mt-1 text-xs">
          None yet. Connect a mailbox above, or a LinkedIn or X account with <code>og connect</code>
          . Each one you add raises how much can go out a day.
        </p>
      </section>
    );
  }

  const total = initial.reduce((sum, sender) => sum + sender.effectiveCapToday, 0);
  const used = initial.reduce((sum, sender) => sum + sender.sentToday, 0);

  return (
    <section className="border-border bg-surface-raised rounded-2xl border p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Sending accounts</h2>
          <p className="text-ink-muted mt-1 text-xs">
            Messages are shared across these. A conversation stays on the account that started it;
            anything else goes to whichever has the most room today.
          </p>
        </div>
        <span className="text-ink-muted shrink-0 text-xs tabular-nums">
          {used}/{total} today
        </span>
      </div>

      <ul className="mt-3 flex flex-col gap-3">
        {initial.map((sender) => (
          <SenderRow key={sender.id} sender={sender} />
        ))}
      </ul>
    </section>
  );
}

const NETWORK_NAMES: Record<SenderView['network'], string> = {
  email: 'Email',
  linkedin: 'LinkedIn',
  x: 'X',
};

function SenderRow({ sender }: { sender: SenderView }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [cap, setCap] = useState(String(sender.configuredCap));

  async function patch(body: Record<string, unknown>): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/v1/senders/${sender.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        setError(payload.error?.message ?? `that failed (${response.status})`);
        return;
      }
      router.refresh();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  const share =
    sender.effectiveCapToday > 0
      ? Math.min(100, Math.round((sender.sentToday / sender.effectiveCapToday) * 100))
      : 100;
  const warming = sender.warmup.enabled && !sender.warmup.complete;
  const warmupShare =
    warming && sender.warmup.rampCapToday !== null
      ? Math.min(100, Math.round((sender.warmup.rampCapToday / sender.configuredCap) * 100))
      : 100;

  return (
    <li className="border-border bg-surface rounded-xl border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {sender.label ?? sender.handle ?? 'Unnamed account'}
          </p>
          <p className="text-ink-muted truncate text-xs">
            {NETWORK_NAMES[sender.network]}
            {sender.label && sender.handle ? ` · ${sender.handle}` : ''}
          </p>
        </div>
        <StatusBadge status={sender.status} />
      </div>

      {sender.status !== 'active' && sender.statusReason ? (
        <p className="text-ink-muted mt-2 text-xs">{sender.statusReason}</p>
      ) : null}

      <div className="mt-3">
        <div className="text-ink-muted flex justify-between text-xs tabular-nums">
          <span>Sent today</span>
          <span>
            {sender.sentToday}/{sender.effectiveCapToday}
          </span>
        </div>
        <div className="bg-surface-raised mt-1 h-1.5 overflow-hidden rounded-full">
          <div className="bg-accent h-full rounded-full" style={{ width: `${share}%` }} />
        </div>
      </div>

      {warming ? (
        <div className="mt-2">
          <div className="text-ink-muted flex justify-between text-xs tabular-nums">
            <span>Warm-up, day {(sender.warmup.day ?? 0) + 1}</span>
            <span>
              {sender.warmup.rampCapToday} of {sender.configuredCap} a day
            </span>
          </div>
          <div className="bg-surface-raised mt-1 h-1.5 overflow-hidden rounded-full">
            <div
              className="h-full rounded-full bg-amber-500"
              style={{ width: `${warmupShare}%` }}
            />
          </div>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {sender.status === 'active' ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => patch({ paused: true })}
            className="border-border min-h-[36px] rounded-xl border px-3 text-xs disabled:opacity-50"
          >
            Pause
          </button>
        ) : sender.status === 'revoked' ? null : (
          <button
            type="button"
            disabled={busy}
            onClick={() => patch({ paused: false })}
            className="bg-accent min-h-[36px] rounded-xl px-3 text-xs font-medium text-white disabled:opacity-50"
          >
            Resume
          </button>
        )}

        <button
          type="button"
          disabled={busy}
          onClick={() => patch({ warmup: !sender.warmup.enabled })}
          className="border-border min-h-[36px] rounded-xl border px-3 text-xs disabled:opacity-50"
        >
          {sender.warmup.enabled ? 'Skip warm-up' : 'Warm up'}
        </button>

        <form
          className="flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            const value = Number(cap);
            if (!Number.isInteger(value) || value < 0) {
              setError('a daily cap is a whole number');
              return;
            }
            void patch({ dailyCap: value });
          }}
        >
          <label htmlFor={`cap-${sender.id}`} className="text-ink-muted text-xs">
            Cap
          </label>
          <input
            id={`cap-${sender.id}`}
            inputMode="numeric"
            value={cap}
            onChange={(event) => setCap(event.target.value)}
            className="border-border bg-surface-raised w-16 rounded-lg border px-2 py-1 text-xs tabular-nums"
          />
          <button
            type="submit"
            disabled={busy || cap === String(sender.configuredCap)}
            className="border-border min-h-[36px] rounded-xl border px-3 text-xs disabled:opacity-50"
          >
            Set
          </button>
        </form>
      </div>

      {error ? <p className="mt-2 text-xs text-rose-600">{error}</p> : null}
    </li>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'active'
      ? 'bg-emerald-500/15 text-emerald-600'
      : status === 'paused'
        ? 'bg-amber-500/15 text-amber-600'
        : 'bg-rose-500/15 text-rose-600';
  const label =
    status === 'active'
      ? 'Active'
      : status === 'paused'
        ? 'Paused'
        : status === 'revoked'
          ? 'Signed out'
          : 'Stopped';
  return (
    <span className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-medium ${tone}`}>
      {label}
    </span>
  );
}

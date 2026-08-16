'use client';

import { useState, type FormEvent } from 'react';
import type { SettingsView } from '../lib/api';

/**
 * Notification and autopilot settings.
 *
 * These are the controls that matter once the product runs unattended: where
 * the mail goes, how loud it is, and how much it is allowed to send in a day.
 * The daily cap in particular is the thing standing between a misconfigured
 * campaign and a burnt sending domain, so it is on this page rather than
 * buried in an environment variable.
 */
export function SettingsForm({ initial }: { initial: SettingsView }) {
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setSaved(false);

    try {
      const response = await fetch('/api/v1/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          notifyEmail: form.notifyEmail || null,
          replyToEmail: form.replyToEmail || null,
          instantAlerts: form.instantAlerts,
          dailyDigest: form.dailyDigest,
          digestHourUtc: form.digestHourUtc,
          alertMinOpportunity: form.alertMinOpportunity,
          autopilotDailyCap: form.autopilotDailyCap,
        }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setError(payload?.error?.message ?? `that failed (${response.status})`);
        return;
      }

      setSaved(true);
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  const update = <K extends keyof SettingsView>(key: K, value: SettingsView[K]): void => {
    setForm((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <section className="border-border bg-surface-raised rounded-2xl border p-4">
        <h2 className="text-sm font-semibold">Where mail goes</h2>

        <label htmlFor="notify" className="text-ink-muted mt-3 block text-xs">
          Notifications
        </label>
        <input
          id="notify"
          type="email"
          value={form.notifyEmail ?? ''}
          onChange={(e) => update('notifyEmail', e.target.value)}
          placeholder={form.effectiveNotifyEmail ?? 'your address'}
          className="border-border bg-surface mt-1 w-full rounded-xl border px-3 py-2.5"
        />
        <p className="text-ink-muted mt-1 text-xs">
          {form.notifyEmail
            ? 'Alerts and the digest go here.'
            : `Leave blank to use ${form.effectiveNotifyEmail ?? 'the account owner’s address'}.`}
        </p>

        <label htmlFor="replyto" className="text-ink-muted mt-4 block text-xs">
          Replies from prospects
        </label>
        <input
          id="replyto"
          type="email"
          value={form.replyToEmail ?? ''}
          onChange={(e) => update('replyToEmail', e.target.value)}
          placeholder={form.effectiveNotifyEmail ?? 'your address'}
          className="border-border bg-surface mt-1 w-full rounded-xl border px-3 py-2.5"
        />
        <p className="text-ink-muted mt-1 text-xs">
          Where a prospect&rsquo;s reply lands — the one part you handle. Connecting your own mail
          server above overrides this with its own reply address.
        </p>
      </section>

      <section className="border-border bg-surface-raised rounded-2xl border p-4">
        <h2 className="text-sm font-semibold">When to interrupt you</h2>

        <label className="mt-3 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.instantAlerts}
            onChange={(e) => update('instantAlerts', e.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="font-medium">Email me the moment a lead is found</span>
            <span className="text-ink-muted block text-[13px] leading-relaxed">
              One message per person, never twice for the same one.
            </span>
          </span>
        </label>

        <label htmlFor="floor" className="text-ink-muted mt-4 block text-xs">
          Only for leads scoring at least {form.alertMinOpportunity}
        </label>
        <input
          id="floor"
          type="range"
          min={0}
          max={100}
          step={5}
          value={form.alertMinOpportunity}
          onChange={(e) => update('alertMinOpportunity', Number(e.target.value))}
          className="mt-2 w-full"
        />

        <label className="mt-5 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.dailyDigest}
            onChange={(e) => update('dailyDigest', e.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="font-medium">Send a daily summary</span>
            <span className="text-ink-muted block text-[13px] leading-relaxed">
              What ran, what was found, what went out. Sent even on a quiet day, so silence always
              means something is wrong.
            </span>
          </span>
        </label>

        <label htmlFor="hour" className="text-ink-muted mt-4 block text-xs">
          Digest hour (UTC)
        </label>
        <input
          id="hour"
          type="number"
          min={0}
          max={23}
          value={form.digestHourUtc}
          onChange={(e) => update('digestHourUtc', Number(e.target.value))}
          className="border-border bg-surface mt-1 w-24 rounded-xl border px-3 py-2.5 tabular-nums"
        />
      </section>

      <section className="border-border bg-surface-raised rounded-2xl border p-4">
        <h2 className="text-sm font-semibold">Autopilot limits</h2>

        <label htmlFor="cap" className="text-ink-muted mt-3 block text-xs">
          Most messages to send per day
        </label>
        <input
          id="cap"
          type="number"
          min={0}
          max={500}
          value={form.autopilotDailyCap}
          onChange={(e) => update('autopilotDailyCap', Number(e.target.value))}
          className="border-border bg-surface mt-1 w-28 rounded-xl border px-3 py-2.5 tabular-nums"
        />
        <p className="text-ink-muted mt-1 text-xs">
          Across every campaign. Set to 0 to stop all unattended sending without switching campaigns
          off one at a time.
        </p>
      </section>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy}
          className="bg-accent rounded-xl px-5 py-3 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        {saved ? <span className="text-ink-muted text-sm">Saved.</span> : null}
      </div>

      {error ? (
        <p role="alert" className="text-hot text-sm">
          {error}
        </p>
      ) : null}
    </form>
  );
}

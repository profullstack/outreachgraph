'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { CadenceRowView } from '../lib/api';

/**
 * Writing a rule: when this happens, do that.
 *
 * The action picker is the interesting part, and specifically what is missing
 * from it. There is no "send an email" and no "post this", because an action
 * that reaches the wire would carry its own opinion about whether it is
 * allowed — and then the product has two policy engines, the deterministic one
 * and whatever the person adding the feature thought, and the quiet one wins.
 *
 * So a rule can only ever *queue* work. Putting somebody on a plan is as far
 * as it goes; whether the plan's steps then run automatically or become
 * one-tap jobs stays the capability matrix's decision. The screen says this
 * out loud rather than leaving somebody to wonder why the obvious option is
 * absent.
 */

const TRIGGERS = [
  { id: 'signal_received', label: 'We see a new signal about them' },
  { id: 'score_crossed', label: 'Their score crosses a threshold' },
  { id: 'reply_received', label: 'They reply' },
  { id: 'stage_changed', label: 'They move in the funnel' },
] as const;

const SIGNAL_TYPES = [
  { id: '', label: 'any kind of signal' },
  { id: 'pain', label: 'a complaint or pain point' },
  { id: 'purchase_intent', label: 'buying intent' },
  { id: 'recommendation_request', label: 'asking for a recommendation' },
  { id: 'competitor_mention', label: 'mentioning a competitor' },
  { id: 'hiring', label: 'hiring' },
  { id: 'funding', label: 'funding' },
  { id: 'launch', label: 'a launch' },
] as const;

export function RuleBuilder({ cadences }: { cadences: CadenceRowView[] }) {
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [trigger, setTrigger] = useState<string>('signal_received');
  const [signalType, setSignalType] = useState('');
  const [contains, setContains] = useState('');
  const [action, setAction] = useState('enroll_cadence');
  const [cadenceId, setCadenceId] = useState(cadences[0]?.id ?? '');
  const [message, setMessage] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function create(): Promise<void> {
    setBusy(true);
    setError(undefined);

    try {
      const response = await fetch('/api/v1/rules', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          name,
          trigger,
          condition: {
            ...(trigger === 'signal_received' && signalType ? { signalType } : {}),
            ...(contains ? { contains } : {}),
          },
          action,
          config: {
            ...(action === 'enroll_cadence' ? { cadenceId } : {}),
            ...(action === 'notify' && message ? { message } : {}),
            ...(action === 'suppress' ? { reason: message || 'matched a rule' } : {}),
          },
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        error?: { message?: string; details?: { rule?: string[] } };
      };

      if (!response.ok) {
        setError(
          payload.error?.details?.rule?.join(' ') ??
            payload.error?.message ??
            `that failed (${response.status})`,
        );
        return;
      }

      setName('');
      setContains('');
      setMessage('');
      setOpen(false);
      router.refresh();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  const needsCadence = action === 'enroll_cadence';
  const canSubmit = name.trim() && (!needsCadence || cadenceId);

  return (
    <section className="border-border bg-surface-raised rounded-2xl border p-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-sm font-semibold"
      >
        <span>Write a rule</span>
        <span className="text-ink-muted text-xs">{open ? 'Hide' : 'Show'}</span>
      </button>

      {open ? (
        <div className="mt-4">
          <label htmlFor="rule-name" className="text-ink-muted block text-xs">
            Name
          </label>
          <input
            id="rule-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Complaints about our competitor"
            className="border-border bg-surface mt-1 w-full rounded-xl border px-3 py-2.5"
          />

          <label htmlFor="rule-trigger" className="text-ink-muted mt-4 block text-xs">
            When
          </label>
          <select
            id="rule-trigger"
            value={trigger}
            onChange={(e) => setTrigger(e.target.value)}
            className="border-border bg-surface mt-1 min-h-[44px] w-full rounded-xl border px-3"
          >
            {TRIGGERS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>

          {trigger === 'signal_received' ? (
            <>
              <label htmlFor="rule-signal" className="text-ink-muted mt-3 block text-xs">
                and it is
              </label>
              <select
                id="rule-signal"
                value={signalType}
                onChange={(e) => setSignalType(e.target.value)}
                className="border-border bg-surface mt-1 min-h-[44px] w-full rounded-xl border px-3"
              >
                {SIGNAL_TYPES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </>
          ) : null}

          <label htmlFor="rule-contains" className="text-ink-muted mt-3 block text-xs">
            and it mentions (optional)
          </label>
          <input
            id="rule-contains"
            value={contains}
            onChange={(e) => setContains(e.target.value)}
            placeholder="stripe"
            className="border-border bg-surface mt-1 w-full rounded-xl border px-3 py-2.5"
          />

          <label htmlFor="rule-action" className="text-ink-muted mt-4 block text-xs">
            Then
          </label>
          <select
            id="rule-action"
            value={action}
            onChange={(e) => setAction(e.target.value)}
            className="border-border bg-surface mt-1 min-h-[44px] w-full rounded-xl border px-3"
          >
            <option value="enroll_cadence">Put them on a plan</option>
            <option value="notify">Tell me</option>
            <option value="suppress">Never contact them again</option>
          </select>

          {needsCadence ? (
            cadences.length > 0 ? (
              <select
                aria-label="Plan to enrol onto"
                value={cadenceId}
                onChange={(e) => setCadenceId(e.target.value)}
                className="border-border bg-surface mt-2 min-h-[44px] w-full rounded-xl border px-3"
              >
                {cadences.map((cadence) => (
                  <option key={cadence.id} value={cadence.id}>
                    {cadence.name}
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-ink-muted mt-2 text-xs">
                No plans yet — make one first, or this rule would fire forever and do nothing.
              </p>
            )
          ) : (
            <input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              aria-label="Note"
              placeholder={action === 'suppress' ? 'why' : 'what to say'}
              className="border-border bg-surface mt-2 w-full rounded-xl border px-3 py-2.5"
            />
          )}

          {error ? <p className="mt-3 text-xs text-rose-600">{error}</p> : null}

          <button
            type="button"
            onClick={create}
            disabled={busy || !canSubmit}
            className="bg-accent mt-4 min-h-[44px] w-full rounded-xl px-4 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Create rule'}
          </button>

          <p className="text-ink-muted mt-3 text-xs leading-relaxed">
            There is no &ldquo;send this&rdquo; option, and that is deliberate. A rule can only
            queue work — whether a plan&rsquo;s steps then run by themselves or become something you
            do by hand is decided by what each network allows, at the moment each step falls due. A
            rule cannot talk its way past that.
          </p>
        </div>
      ) : null}
    </section>
  );
}

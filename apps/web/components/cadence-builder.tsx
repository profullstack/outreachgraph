'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { PlaybookRowView } from '../lib/api';

/**
 * Starting a plan, from a play or from nothing.
 *
 * The playbook list comes first and the blank form is behind a disclosure,
 * which is the opposite of how this normally gets built and is deliberate.
 * Everything downstream of a campaign works well once it describes a real
 * market and a real trigger, and not at all when somebody types "founders"
 * because the box was empty. A worked example that happens to be executable is
 * a better starting point than a form.
 *
 * The step editor deliberately does not say whether a step will be automated.
 * It cannot: that is decided by the capability matrix at the moment the step
 * falls due, against the policy version and the connected accounts in force
 * then. Showing a guess here would be a promise the engine has not made.
 */

const NETWORKS = [
  { id: 'email', label: 'Email' },
  { id: 'bluesky', label: 'Bluesky' },
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'x', label: 'X' },
  { id: 'mastodon', label: 'Mastodon' },
  { id: 'reddit', label: 'Reddit' },
] as const;

const ACTIONS = [
  { id: 'send_email', label: 'Send an email' },
  { id: 'reply', label: 'Reply publicly' },
  { id: 'comment', label: 'Comment' },
  { id: 'send_dm', label: 'Send a direct message' },
  { id: 'like', label: 'Like something' },
  { id: 'follow', label: 'Follow' },
  { id: 'view_profile', label: 'Look at their profile' },
  { id: 'observe', label: 'Just watch' },
] as const;

interface DraftStep {
  network: string;
  action: string;
  delayHours: number;
  intent: string;
}

function blankStep(): DraftStep {
  return { network: 'email', action: 'send_email', delayHours: 72, intent: '' };
}

export function CadenceBuilder({ playbooks }: { playbooks: PlaybookRowView[] }) {
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [steps, setSteps] = useState<DraftStep[]>([
    { network: 'email', action: 'send_email', delayHours: 0, intent: '' },
  ]);
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  async function usePlaybook(slug: string): Promise<void> {
    setBusy(slug);
    setError(undefined);

    try {
      const response = await fetch(`/api/v1/playbooks/${encodeURIComponent(slug)}/use`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({}),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
      };

      if (!response.ok) {
        setError(payload.error?.message ?? `that failed (${response.status})`);
        return;
      }

      router.refresh();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(undefined);
    }
  }

  async function create(): Promise<void> {
    setBusy('custom');
    setError(undefined);

    try {
      const response = await fetch('/api/v1/cadences', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          name,
          steps: steps.map((step, index) => ({
            position: index,
            network: step.network,
            action: step.action,
            delayHours: Number(step.delayHours),
            stopOnReply: true,
            ...(step.intent ? { intent: step.intent } : {}),
          })),
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        error?: { message?: string; details?: { steps?: string[] } };
      };

      if (!response.ok) {
        // The engine's own sentences. "This plan never contacts anybody" is
        // useful; "400" is not.
        const problems = payload.error?.details?.steps;
        setError(
          problems?.join(' ') ?? payload.error?.message ?? `that failed (${response.status})`,
        );
        return;
      }

      setName('');
      setSteps([{ network: 'email', action: 'send_email', delayHours: 0, intent: '' }]);
      setOpen(false);
      router.refresh();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(undefined);
    }
  }

  function update(index: number, patch: Partial<DraftStep>): void {
    setSteps((current) => current.map((step, i) => (i === index ? { ...step, ...patch } : step)));
  }

  const totalHours = steps.reduce((sum, step) => sum + Number(step.delayHours || 0), 0);

  return (
    <div className="flex flex-col gap-4">
      <section className="border-border bg-surface-raised rounded-2xl border p-4">
        <h2 className="text-sm font-semibold">Start from a play</h2>
        <p className="text-ink-muted mt-1 text-xs">
          Each one is a worked example that runs as it is: who to look for, what should trigger a
          touch, and the sequence of touches.
        </p>

        <ul className="mt-3 flex flex-col gap-2">
          {playbooks.map((playbook) => (
            <li key={playbook.slug} className="border-border rounded-xl border p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium">{playbook.name}</div>
                  <div className="text-ink-muted text-xs">{playbook.summary}</div>
                  <div className="text-ink-muted mt-1 text-[11px]">
                    {playbook.steps} steps over {formatHours(playbook.durationHours)} ·{' '}
                    {playbook.audience}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => usePlaybook(playbook.slug)}
                  disabled={busy !== undefined}
                  className="border-border min-h-[40px] shrink-0 rounded-xl border px-3 text-sm disabled:opacity-50"
                >
                  {busy === playbook.slug ? 'Adding…' : 'Use'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="border-border bg-surface-raised rounded-2xl border p-4">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center justify-between text-sm font-semibold"
        >
          <span>Or build one</span>
          <span className="text-ink-muted text-xs">{open ? 'Hide' : 'Show'}</span>
        </button>

        {open ? (
          <div className="mt-4">
            <label htmlFor="cadence-name" className="text-ink-muted block text-xs">
              Name
            </label>
            <input
              id="cadence-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Competitor switchers, second pass"
              className="border-border bg-surface mt-1 w-full rounded-xl border px-3 py-2.5"
            />

            <ol className="mt-4 flex flex-col gap-3">
              {steps.map((step, index) => (
                <li key={index} className="border-border rounded-xl border p-3">
                  <div className="text-ink-muted mb-2 text-[11px] font-medium tracking-wide uppercase">
                    Step {index + 1}
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <select
                      aria-label={`Step ${index + 1} network`}
                      value={step.network}
                      onChange={(e) => update(index, { network: e.target.value })}
                      className="border-border bg-surface min-h-[44px] rounded-xl border px-3"
                    >
                      {NETWORKS.map((n) => (
                        <option key={n.id} value={n.id}>
                          {n.label}
                        </option>
                      ))}
                    </select>

                    <select
                      aria-label={`Step ${index + 1} action`}
                      value={step.action}
                      onChange={(e) => update(index, { action: e.target.value })}
                      className="border-border bg-surface min-h-[44px] rounded-xl border px-3"
                    >
                      {ACTIONS.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.label}
                        </option>
                      ))}
                    </select>

                    <label className="text-ink-muted flex items-center gap-2 text-xs">
                      after
                      <input
                        type="number"
                        min={0}
                        aria-label={`Step ${index + 1} delay in hours`}
                        value={step.delayHours}
                        onChange={(e) => update(index, { delayHours: Number(e.target.value) })}
                        className="border-border bg-surface min-h-[44px] w-20 rounded-xl border px-3 tabular-nums"
                      />
                      h
                    </label>
                  </div>

                  <input
                    value={step.intent}
                    onChange={(e) => update(index, { intent: e.target.value })}
                    placeholder="what this touch is for — “reference their talk”"
                    className="border-border bg-surface mt-2 w-full rounded-xl border px-3 py-2 text-sm"
                  />

                  {steps.length > 1 ? (
                    <button
                      type="button"
                      onClick={() => setSteps((c) => c.filter((_, i) => i !== index))}
                      className="text-ink-muted mt-2 text-xs underline"
                    >
                      Remove
                    </button>
                  ) : null}
                </li>
              ))}
            </ol>

            <div className="mt-3 flex items-center justify-between">
              <button
                type="button"
                onClick={() => setSteps((c) => [...c, blankStep()])}
                className="border-border min-h-[40px] rounded-xl border px-3 text-sm"
              >
                Add a step
              </button>
              <span className="text-ink-muted text-xs">
                {steps.length} touches over {formatHours(totalHours)}
              </span>
            </div>

            {error ? <p className="mt-3 text-xs text-rose-600">{error}</p> : null}

            <button
              type="button"
              onClick={create}
              disabled={busy !== undefined || !name.trim()}
              className="bg-accent mt-4 min-h-[44px] w-full rounded-xl px-4 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy === 'custom' ? 'Creating…' : 'Create as a draft'}
            </button>

            <p className="text-ink-muted mt-3 text-xs">
              Whether a step runs by itself or becomes something you do by hand is decided when it
              falls due, by what the network allows and what you have connected — not here.
            </p>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function formatHours(hours: number): string {
  if (hours === 0) return 'no wait';
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)} days`;
}

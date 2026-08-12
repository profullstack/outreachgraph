'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

/**
 * Add one prospect by GitHub handle (PRD §8).
 *
 * The chain runs synchronously, so this reports what actually happened rather
 * than "queued": how many identities were linked and how many signals were
 * found is the difference between a prospect worth pursuing and a dead end,
 * and hiding it behind a spinner that resolves to nothing was the old
 * behaviour of an empty app.
 *
 * A handle that resolves to no profile comes back 200 with a reason. That is
 * a typo, not a server fault, and it is shown as a note rather than an error.
 */
export function AddProspect() {
  const router = useRouter();
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!handle.trim()) return;

    setBusy(true);
    setError(undefined);
    setNote(undefined);

    try {
      const response = await fetch('/api/v1/prospects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ handle }),
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(payload?.error?.message ?? `that failed (${response.status})`);
        return;
      }

      if (!payload.added) {
        setNote(payload.reason ?? 'nothing to add for that handle');
        return;
      }

      const found =
        payload.signalsStored > 0
          ? `${payload.signalsStored} signal${payload.signalsStored === 1 ? '' : 's'} found`
          : 'no public signals yet';

      setNote(`Added. ${payload.identitiesLinked} identities linked, ${found}.`);
      setHandle('');
      router.refresh();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="border-border bg-surface-raised rounded-2xl border p-4">
      <label htmlFor="handle" className="text-sm font-medium">
        Add a prospect
      </label>
      <p className="text-ink-muted mt-1 text-xs">
        A GitHub username or profile URL. GitHub first because it is free and its profiles carry
        links the person published themselves.
      </p>

      <div className="mt-3 flex gap-2">
        <input
          id="handle"
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          placeholder="octocat"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="border-border bg-surface min-w-0 flex-1 rounded-xl border px-3 py-3"
        />
        <button
          type="submit"
          disabled={busy || !handle.trim()}
          className="bg-accent shrink-0 rounded-xl px-4 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? 'Researching…' : 'Add'}
        </button>
      </div>

      {busy ? (
        <p className="text-ink-muted mt-2 text-xs">
          Enriching, resolving identities, collecting signals and scoring — a few seconds.
        </p>
      ) : null}

      {note ? <p className="text-ink-muted mt-2 text-sm">{note}</p> : null}

      {error ? (
        <p role="alert" className="text-hot mt-2 text-sm">
          {error}
        </p>
      ) : null}
    </form>
  );
}

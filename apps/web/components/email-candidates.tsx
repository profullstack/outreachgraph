'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { EmailCandidateRow } from '../lib/types';

/**
 * How a prospect stops being unreachable.
 *
 * Every prospect in production resolves to their company's shared inbox,
 * because none of them has a personal address. The address limits then refuse
 * almost every approval, correctly — one `support@` standing in for seventeen
 * people should not receive seventeen messages. There is simply nowhere else
 * to send, and no amount of crawling fixes it: every address published on
 * these companies' `/team` and `/about` pages is a role mailbox.
 *
 * So this asks the one question the machine cannot answer. Each row is a
 * derived guess with its reasoning attached, and confirming one writes the
 * email identity the sender reads. Two things follow immediately: the message
 * reaches the person instead of their front desk, and they stop being
 * rate-limited alongside every colleague behind that mailbox.
 *
 * The free-text box matters more than the list. An address the operator simply
 * knows is worth more than anything derived, because confirming it teaches the
 * company's shape to every colleague — the next person at that domain arrives
 * as a derivation rather than a guess.
 */
export function EmailCandidates({
  personId,
  candidates,
  hasPersonalAddress,
}: {
  personId: string;
  candidates: EmailCandidateRow[];
  hasPersonalAddress: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [typed, setTyped] = useState('');

  const confirmed = candidates.find((candidate) => candidate.status === 'confirmed');
  const open = candidates.filter((candidate) => candidate.status === 'proposed');

  async function decide(action: 'confirm' | 'reject', address: string) {
    setBusy(`${action}:${address}`);
    setError(undefined);

    try {
      const response = await fetch(`/api/v1/people/${personId}/email-candidates/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ address }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        setError(payload.error?.message ?? `that failed (${response.status})`);
        return;
      }

      setTyped('');
      router.refresh();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(undefined);
    }
  }

  // Nothing to decide and nothing to fix: they are already reachable.
  if (hasPersonalAddress && open.length === 0) return null;

  return (
    <section className="mt-6">
      <h2 className="text-ink-muted text-[11px] font-semibold tracking-wide uppercase">
        Personal address
      </h2>

      {confirmed ? (
        <p className="mt-2 text-sm">
          Sending to <span className="font-medium">{confirmed.address}</span>, confirmed by you.
        </p>
      ) : (
        <p className="text-ink-muted mt-2 text-sm">
          No personal address, so messages go to this company&rsquo;s shared inbox — where they
          count against everyone else queued behind it. Confirm one below and this person is reached
          directly.
        </p>
      )}

      {open.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-2">
          {open.map((candidate) => (
            <li key={candidate.id} className="border-border rounded-xl border p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">{candidate.address}</span>
                <span className="text-ink-muted shrink-0 text-[11px]">
                  {candidate.derived ? 'derived' : 'guess'}
                </span>
              </div>

              {candidate.basis ? (
                <p className="text-ink-muted mt-1 text-xs">{candidate.basis}</p>
              ) : null}

              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => decide('confirm', candidate.address)}
                  className="bg-accent rounded-lg px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60"
                >
                  {busy === `confirm:${candidate.address}` ? 'Confirming…' : 'This is right'}
                </button>
                <button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => decide('reject', candidate.address)}
                  className="border-border rounded-lg border px-3 py-1.5 text-xs font-medium disabled:opacity-60"
                >
                  Not this
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {confirmed ? null : (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (typed.trim()) void decide('confirm', typed.trim());
          }}
        >
          <input
            type="email"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder="Or type the address you know"
            className="border-border min-w-0 flex-1 rounded-xl border px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={Boolean(busy) || !typed.trim()}
            className="border-border rounded-xl border px-3 py-2 text-sm font-medium disabled:opacity-40"
          >
            Save
          </button>
        </form>
      )}

      {error ? (
        <p role="alert" className="text-hot mt-2 text-sm">
          {error}
        </p>
      ) : null}
    </section>
  );
}

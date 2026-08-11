'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
// Imported from the server-safe modules, not lib/api: that pulls in
// next/headers and cannot be bundled for the browser.
import { relativeTime } from '../lib/format';
import type { ApprovalCard as Card } from '../lib/types';

/**
 * The approval card (PRD §15).
 *
 * Order is deliberate: who, then why now, then what we propose, then the
 * words — so the reviewer forms a judgement about the evidence before reading
 * a draft that might read persuasively regardless.
 *
 * A denied approval is not a failure to hide: the API answers 409 naming the
 * policy gate that stopped it, and that reason is shown verbatim. Silently
 * dropping it would leave the user thinking they had sent something.
 */
export function ApprovalCard({ card }: { card: Card }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [body, setBody] = useState(card.draft_body ?? '');
  const [editing, setEditing] = useState(false);

  async function act(action: 'approve' | 'skip', payload?: Record<string, unknown>) {
    setBusy(action);
    setError(undefined);

    try {
      const response = await fetch(`/api/v1/recommendations/${card.id}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload ?? {}),
      });

      if (!response.ok) {
        const failure = await response.json().catch(() => ({}));
        setError(failure?.error?.message ?? `that failed (${response.status})`);
        return;
      }

      router.refresh();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <article className="border-border bg-surface-raised rounded-2xl border p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold">{card.display_name}</h2>
          <p className="text-ink-muted truncate text-sm">{card.current_title ?? '—'}</p>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-accent text-lg leading-none font-semibold tabular-nums">
            {card.opportunity ?? '—'}
          </div>
          <div className="text-ink-muted text-[11px]">opportunity</div>
        </div>
      </header>

      <dl className="text-ink-muted mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <div className="flex gap-1">
          <dt>Identity</dt>
          <dd className="text-ink font-medium tabular-nums">
            {Math.round(card.identity_confidence * 100)}%
          </dd>
        </div>
        <div className="flex gap-1">
          <dt>Channel</dt>
          <dd className="text-ink font-medium">{card.network}</dd>
        </div>
      </dl>

      {card.signal_summary ? (
        <section className="border-hot/40 bg-hot/5 mt-4 rounded-xl border-l-2 p-3">
          <h3 className="text-hot text-[11px] font-semibold tracking-wide uppercase">Why now</h3>
          <p className="mt-1 text-sm">{card.signal_summary}</p>
          <p className="text-ink-muted mt-1 text-xs">
            {relativeTime(card.signal_at)}
            {card.signal_url ? (
              <>
                {' · '}
                <a className="text-accent underline" href={card.signal_url} rel="noreferrer">
                  source
                </a>
              </>
            ) : null}
          </p>
        </section>
      ) : null}

      <section className="mt-4">
        <h3 className="text-ink-muted text-[11px] font-semibold tracking-wide uppercase">
          Recommended
        </h3>
        <p className="mt-1 text-sm">
          <span className="font-medium capitalize">{card.action.replace(/_/g, ' ')}</span>
          {' — '}
          {card.reason}
        </p>
      </section>

      {card.draft_body ? (
        <section className="mt-4">
          <h3 className="text-ink-muted text-[11px] font-semibold tracking-wide uppercase">
            Draft
          </h3>
          {editing ? (
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={5}
              className="border-border mt-1 w-full rounded-xl border p-3 text-sm"
            />
          ) : (
            <p className="border-border mt-1 rounded-xl border p-3 text-sm whitespace-pre-wrap">
              {body}
            </p>
          )}
        </section>
      ) : null}

      {error ? (
        <p role="alert" className="text-hot mt-3 text-sm">
          {error}
        </p>
      ) : null}

      <div className="mt-4 grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={Boolean(busy)}
          onClick={() =>
            act('approve', editing && body !== card.draft_body ? { editedBody: body } : {})
          }
          className="bg-accent rounded-xl py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {busy === 'approve' ? 'Approving…' : 'Approve'}
        </button>

        <button
          type="button"
          disabled={Boolean(busy) || !card.draft_body}
          onClick={() => setEditing((v) => !v)}
          className="border-border rounded-xl border py-2 text-sm font-medium disabled:opacity-40"
        >
          {editing ? 'Done editing' : 'Edit'}
        </button>

        <button
          type="button"
          disabled={Boolean(busy)}
          onClick={() => act('skip')}
          className="border-border rounded-xl border py-2 text-sm font-medium disabled:opacity-60"
        >
          {busy === 'skip' ? 'Skipping…' : 'Skip'}
        </button>

        <button
          type="button"
          disabled={Boolean(busy)}
          onClick={async () => {
            // Suppression is not an undo — say so before writing a tombstone
            // that deliberately outlives the prospect record.
            if (!confirm(`Never contact ${card.display_name} again? This cannot be undone.`))
              return;
            setBusy('suppress');
            setError(undefined);
            try {
              const response = await fetch('/api/v1/suppressions', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({
                  matchKeys: [`person:${card.person_id}`],
                  reason: 'do_not_contact',
                  scope: 'workspace',
                }),
              });
              if (!response.ok) {
                setError('could not suppress this person');
                return;
              }
              await act('skip');
            } finally {
              setBusy(undefined);
            }
          }}
          className="border-border text-hot rounded-xl border py-2 text-sm font-medium disabled:opacity-60"
        >
          Do not contact
        </button>
      </div>
    </article>
  );
}

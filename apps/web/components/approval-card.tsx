'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
// Imported from the server-safe modules, not lib/api: that pulls in
// next/headers and cannot be bundled for the browser.
import { relativeTime } from '../lib/format';
import { ShareButtons } from './share-buttons';
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
/**
 * Why no draft was written, in the reviewer's language.
 *
 * The reason is shown rather than hidden behind "try again", because every
 * one of these is a fact about the evidence: retrying will not change it, and
 * the honest next step is for the reviewer to write the message themselves.
 */
function explainWithholding(reason: string, unsupported?: string[]): string {
  switch (reason) {
    case 'no_evidence':
      return 'No draft: nothing quotable was captured for this signal, and a personalised message with nothing behind it is worse than none.';
    case 'no_trigger_signal':
      return 'No draft: this recommendation has no signal to reference.';
    case 'failed_checks':
      return unsupported?.length
        ? `No draft: the wording kept asserting things nothing supports — ${unsupported.join(', ')}.`
        : 'No draft: the wording did not pass the quality checks.';
    case 'model_refused':
    case 'empty':
      return 'No draft: the writer declined to produce one.';
    default:
      return `No draft (${reason}).`;
  }
}

/**
 * Why this card cannot be approved yet.
 *
 * The reason the API gives is precise but not self-explanatory: "this address
 * was last contacted 12h ago" is baffling next to a prospect who has never
 * been written to, and that is exactly the case it fires on — the limit is on
 * the mailbox, and with no personal address the mailbox is the company's, read
 * by one person on behalf of everybody in it. So the address is named, and
 * whether it is shared is said out loud. Without both, the refusal reads as a
 * bug in the queue rather than the protection it is.
 */
function HoldNotice({ hold }: { hold: NonNullable<Card['hold']> }) {
  return (
    <section className="border-border bg-surface mt-4 rounded-xl border p-3">
      <h3 className="text-ink-muted text-[11px] font-semibold tracking-wide uppercase">
        Held — cannot approve yet
      </h3>
      <p className="mt-1 text-sm">{hold.reason}</p>
      <p className="text-ink-muted mt-1 text-xs">
        Goes to <span className="text-ink font-medium">{hold.address}</span>
        {hold.shared ? ', a shared company inbox — not a personal address' : ''}.
        {hold.clears_at ? ` Clears ${relativeTime(hold.clears_at)}.` : ''}
      </p>
    </section>
  );
}

export function ApprovalCard({ card }: { card: Card }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [body, setBody] = useState(card.draft_body ?? '');
  // What the composer produced, so an approval can tell an edit from the
  // original rather than reporting every composed message as user-written.
  const [original, setOriginal] = useState(card.draft_body ?? '');
  const [withheld, setWithheld] = useState<string | undefined>();
  const [editing, setEditing] = useState(false);

  /**
   * Ask the composer for wording.
   *
   * A withheld draft comes back 200 with a reason — it is the designed
   * outcome when nothing in the evidence supports a message, not an error.
   * It is shown as a note so the reviewer knows to write it themselves.
   */
  async function compose() {
    setBusy('draft');
    setError(undefined);
    setWithheld(undefined);

    try {
      const response = await fetch(`/api/v1/recommendations/${card.id}/draft`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: '{}',
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(payload?.error?.message ?? `that failed (${response.status})`);
        return;
      }

      if (!payload.drafted) {
        setWithheld(explainWithholding(payload.reason, payload.unsupported));
        return;
      }

      setBody(payload.body);
      setOriginal(payload.body);
      router.refresh();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(undefined);
    }
  }

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

      const result = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
        delivery?: { sent?: boolean; to?: string; reason?: string };
      };

      if (!response.ok) {
        setError(result.error?.message ?? `that failed (${response.status})`);
        return;
      }

      // Approving an email sends it. Whether it actually left is the only
      // thing the reviewer wants to know next, and it is not something a page
      // refresh communicates on its own — a card that simply disappears reads
      // as success even when the mail server refused the login.
      if (result.delivery && !result.delivery.sent) {
        setError(`Approved, but not sent: ${result.delivery.reason ?? 'unknown reason'}`);
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

      {card.hold ? <HoldNotice hold={card.hold} /> : null}

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

      <section className="mt-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-ink-muted text-[11px] font-semibold tracking-wide uppercase">
            Draft
          </h3>
          <button
            type="button"
            disabled={Boolean(busy)}
            onClick={compose}
            className="text-accent text-xs font-medium underline disabled:opacity-40"
          >
            {busy === 'draft' ? 'Writing…' : body ? 'Rewrite' : 'Write draft'}
          </button>
        </div>

        {editing ? (
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={5}
            className="border-border mt-1 w-full rounded-xl border p-3 text-sm"
          />
        ) : body ? (
          <p className="border-border mt-1 rounded-xl border p-3 text-sm whitespace-pre-wrap">
            {body}
          </p>
        ) : (
          <p className="text-ink-muted mt-1 text-sm">
            No draft. Read the evidence above and write it yourself, or ask for one.
          </p>
        )}

        {withheld ? (
          <p className="border-border text-ink-muted mt-2 rounded-xl border border-dashed p-3 text-xs">
            {withheld}
          </p>
        ) : null}

        {/*
          Email is not the only way to reach someone, and for the networks the
          policy engine marks manual-only it is the *only* way the product can
          help at all. Offered once there is something to post: a prefilled
          composer with no message in it is just a link to a social network.
        */}
        {body ? <ShareButtons recommendationId={card.id} /> : null}
      </section>

      {error ? (
        <p role="alert" className="text-hot mt-3 text-sm">
          {error}
          {/* A refusal with nowhere to go about it reads as a bug. The budget
              gate is the one denial here that the reviewer can actually clear
              themselves, so it is the one that gets a way out. */}
          {/budget|credit/i.test(error) ? (
            <>
              {' '}
              <a href="/billing" className="underline">
                Buy credits
              </a>
              .
            </>
          ) : null}
        </p>
      ) : null}

      <div className="mt-4 grid grid-cols-2 gap-2">
        <button
          type="button"
          // A held card's approval is already known to fail, so the button
          // does not offer it. Every other control stays live: skipping,
          // editing and suppressing a held card are all still reasonable, and
          // are in fact what a reviewer most often wants to do with one.
          disabled={Boolean(busy) || Boolean(card.hold)}
          onClick={() => act('approve', body && body !== original ? { editedBody: body } : {})}
          {...(card.hold ? { title: card.hold.reason } : {})}
          className="bg-accent rounded-xl py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {card.hold
            ? 'Held'
            : busy === 'approve'
              ? card.network === 'email'
                ? 'Sending…'
                : 'Approving…'
              : // Say what the button does. On email it is not a filing action:
                // pressing it puts the message in someone's inbox.
                card.network === 'email'
                ? 'Approve & send'
                : 'Approve'}
        </button>

        <button
          type="button"
          disabled={Boolean(busy)}
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

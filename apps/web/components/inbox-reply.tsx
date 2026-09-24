'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * The answer box under a thread.
 *
 * When triage drafted an answer, it is already in the box: the reviewer reads
 * it, edits it if they want, and sends. That is the whole copilot promise, and
 * it only holds if sending here *is* approving the card — the API does that,
 * so there is never a sent reply and a stale draft of it left in the queue.
 *
 * "Discard draft" skips the card rather than deleting anything, so the
 * decision is in the audit trail like every other skip.
 */
export function InboxReply({
  personId,
  draft,
  recommendationId,
  canEmail,
}: {
  personId: string;
  draft?: string | null;
  recommendationId?: string | null;
  /** False when there is no email thread to answer; the box explains instead. */
  canEmail: boolean;
}) {
  const router = useRouter();
  const [body, setBody] = useState(draft ?? '');
  const [busy, setBusy] = useState<'send' | 'discard'>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  async function sendReply() {
    if (!body.trim()) return;
    setBusy('send');
    setError(undefined);
    setNotice(undefined);

    try {
      const response = await fetch(`/api/v1/inbox/${encodeURIComponent(personId)}/reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ text: body }),
      });
      const result = (await response.json().catch(() => ({}))) as {
        sent?: boolean;
        to?: string;
        reason?: string;
        note?: string;
        error?: { message?: string };
      };

      if (!response.ok) {
        setError(result.error?.message ?? result.reason ?? `that failed (${response.status})`);
        return;
      }
      if (!result.sent) {
        setNotice(result.note ?? 'Recorded, but not sent.');
        return;
      }

      setNotice(`Sent to ${result.to ?? 'them'}.`);
      router.refresh();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(undefined);
    }
  }

  async function discard() {
    if (!recommendationId) return;
    setBusy('discard');
    setError(undefined);
    try {
      const response = await fetch(`/api/v1/recommendations/${recommendationId}/skip`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: '{}',
      });
      if (!response.ok) {
        setError(`could not discard the draft (${response.status})`);
        return;
      }
      setBody('');
      router.refresh();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(undefined);
    }
  }

  if (!canEmail) {
    return (
      <p className="border-border text-ink-muted rounded-xl border border-dashed p-3 text-xs">
        Only email threads can be answered from here. Reply on the network itself.
      </p>
    );
  }

  return (
    <section className="border-border bg-surface-raised rounded-2xl border p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-ink-muted text-[11px] font-semibold tracking-wide uppercase">
          {draft ? 'Drafted reply' : 'Reply'}
        </h2>
        {draft ? (
          <span className="text-ink-muted text-[11px]">Grounded in the thread; edit freely</span>
        ) : null}
      </div>

      <textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        rows={6}
        placeholder="Write your reply…"
        className="border-border bg-surface mt-2 w-full rounded-xl border p-3 text-sm"
      />

      {error ? <p className="text-hot mt-2 text-sm">{error}</p> : null}
      {notice ? <p className="text-good mt-2 text-sm">{notice}</p> : null}

      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={Boolean(busy) || !body.trim()}
          onClick={sendReply}
          className="bg-accent rounded-xl py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {busy === 'send' ? 'Sending…' : draft && body === draft ? 'Approve & send' : 'Send'}
        </button>
        <button
          type="button"
          disabled={Boolean(busy) || !recommendationId}
          onClick={discard}
          className="border-border rounded-xl border py-2 text-sm font-medium disabled:opacity-40"
        >
          {busy === 'discard' ? 'Discarding…' : 'Discard draft'}
        </button>
      </div>
    </section>
  );
}

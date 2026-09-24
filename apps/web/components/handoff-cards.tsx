'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Avatar } from './avatar';
import type { HandoffView } from '../lib/types';

/**
 * Hand-off cards: the work the product may not do itself, made quick.
 *
 * LinkedIn forbids automated engagement and X needs a connected account, and
 * production's queue was 200 cards of exactly that — 175 LinkedIn, 25 X —
 * that nobody could approve. Approving one now puts it here instead, and the
 * card's job is to make doing it by hand take about thirty seconds on a phone:
 * copy the words, open the exact post, paste, come back, Mark done.
 *
 * The text is editable because the reviewer is the one posting it under
 * their own name; Copy copies what is in the box, not what was drafted.
 */
export function HandoffCards({ handoffs }: { handoffs: HandoffView[] }) {
  const [hidden, setHidden] = useState<string[]>([]);
  const visible = handoffs.filter((handoff) => !hidden.includes(handoff.actionId));

  if (visible.length === 0) {
    return (
      <div className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
        <p>No hand-offs waiting.</p>
        <p className="mt-1">
          Cards the product cannot send for you land here once you approve them.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {visible.map((handoff) => (
        <HandoffCard
          key={handoff.actionId}
          handoff={handoff}
          onGone={() => setHidden((current) => [...current, handoff.actionId])}
        />
      ))}
    </div>
  );
}

/** "Comment on LinkedIn", "Follow on GitHub", "Email". */
function headline(handoff: HandoffView): string {
  const verbs: Record<string, string> = {
    reply: 'Reply',
    comment: 'Comment',
    like: 'Like a post',
    follow: 'Follow',
    connect: 'Connect',
    send_dm: 'Message',
    send_email: 'Email',
  };
  const verb = verbs[handoff.action] ?? handoff.action.replace(/_/g, ' ');
  if (handoff.network === 'email') return verb;
  const network = handoff.network === 'x' ? 'X' : capitalise(handoff.network);
  return `${verb} on ${network}`;
}

function capitalise(value: string): string {
  if (value === 'linkedin') return 'LinkedIn';
  if (value === 'github') return 'GitHub';
  if (value === 'youtube') return 'YouTube';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function HandoffCard({ handoff, onGone }: { handoff: HandoffView; onGone: () => void }) {
  const router = useRouter();
  const [text, setText] = useState(handoff.text);
  const [copied, setCopied] = useState(false);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState<'done' | 'skip' | undefined>();
  const [error, setError] = useState<string | undefined>();

  // Likes and follows carry no words; a textarea there is only in the way.
  const wordless = handoff.action === 'like' || handoff.action === 'follow';

  async function copy(): Promise<void> {
    setError(undefined);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access is refused on plain http and in some in-app
      // browsers. The text is still in the box to select by hand.
      setError('Copy was blocked here. Select the text and copy it yourself.');
    }
  }

  async function finish(kind: 'done' | 'skip'): Promise<void> {
    setBusy(kind);
    setError(undefined);

    const trimmed = link.trim();
    const path =
      kind === 'done'
        ? `/api/v1/actions/${encodeURIComponent(handoff.actionId)}/execute`
        : `/api/v1/handoffs/${encodeURIComponent(handoff.actionId)}/skip`;
    const body =
      kind === 'done'
        ? { mode: 'manual', ...(/^https?:\/\//i.test(trimmed) ? { externalUrl: trimmed } : {}) }
        : {};

    try {
      const response = await fetch(path, {
        method: 'POST',
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

      onGone();
      router.refresh();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <article className="border-border bg-surface-raised rounded-2xl border p-4">
      <header className="flex min-w-0 items-center gap-3">
        <Avatar name={handoff.personName} size="md" />
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold">{handoff.personName}</h2>
          <p className="text-ink-muted truncate text-sm">{headline(handoff)}</p>
        </div>
      </header>

      {!wordless ? (
        <section className="mt-3">
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={5}
            placeholder="Nothing was drafted. Write two lines of your own."
            aria-label="Text to paste"
            className="border-border bg-surface w-full rounded-xl border px-3 py-3 font-mono text-[13px]"
          />
          <p className="text-ink-muted text-right text-xs tabular-nums">
            {text.length.toLocaleString()} chars
          </p>
        </section>
      ) : null}

      <div className="mt-3 grid grid-cols-2 gap-2">
        {!wordless ? (
          <button
            type="button"
            onClick={() => void copy()}
            disabled={text.length === 0}
            className="border-border rounded-xl border py-2 text-sm font-medium disabled:opacity-50"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        ) : null}
        {handoff.openUrl ? (
          <a
            href={handoff.openUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={`bg-accent rounded-xl py-2 text-center text-sm font-medium text-white ${
              wordless ? 'col-span-2' : ''
            }`}
          >
            {handoff.openLabel}
          </a>
        ) : (
          <p className="text-ink-muted self-center text-xs">
            No link on file for this person. Find them on {capitalise(handoff.network)}.
          </p>
        )}
      </div>

      <ol className="text-ink-muted mt-3 list-decimal pl-5 text-sm">
        {handoff.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>

      <details className="text-ink-muted mt-2 text-xs">
        <summary className="cursor-pointer">Add a link to what you posted (optional)</summary>
        <input
          type="url"
          value={link}
          onChange={(event) => setLink(event.target.value)}
          placeholder="https://"
          className="border-border bg-surface mt-1 w-full rounded-xl border px-3 py-2 text-sm"
        />
      </details>

      {error ? (
        <p role="alert" className="text-hot mt-2 text-sm">
          {error}
        </p>
      ) : null}

      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => void finish('done')}
          disabled={busy !== undefined}
          className="bg-accent rounded-xl py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {busy === 'done' ? 'Saving…' : 'Mark done'}
        </button>
        <button
          type="button"
          onClick={() => void finish('skip')}
          disabled={busy !== undefined}
          className="border-border rounded-xl border py-2 text-sm font-medium disabled:opacity-60"
        >
          {busy === 'skip' ? 'Skipping…' : 'Skip'}
        </button>
      </div>
    </article>
  );
}

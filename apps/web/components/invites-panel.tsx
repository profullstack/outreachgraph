'use client';

import { useState } from 'react';
import type { InvitesView } from '../lib/api';

/**
 * Making and sharing invites. A new invite's link is shown once: only its hash
 * is stored, so it cannot be shown again.
 */
export function InvitesPanel({ initial }: { initial: InvitesView }) {
  const [view, setView] = useState(initial);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [copied, setCopied] = useState<string | undefined>();

  async function create() {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch('/api/v1/invites', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ note }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        url?: string;
        error?: { message?: string };
      };
      if (!response.ok || !body.url) {
        setError(body.error?.message ?? 'Could not make an invite.');
        return;
      }
      setFresh(body.url);
      setNote('');
      const refreshed = await fetch('/api/v1/invites', { credentials: 'same-origin' });
      if (refreshed.ok) setView((await refreshed.json()) as InvitesView);
    } catch {
      setError('Could not reach the API.');
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
    } catch {
      // Clipboard refused (insecure context); the text is selectable anyway.
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="border-border bg-surface-raised rounded-2xl border p-4">
        <h2 className="font-medium">
          {view.quota.left} of {view.quota.total} invites left
        </h2>
        <p className="text-ink-muted mt-1 text-sm">
          Each invite works once, for a new account, and lasts 30 days.
          {view.bonusProspects > 0
            ? ` When they confirm their email, you both get ${view.bonusProspects} prospect credits.`
            : ''}
        </p>

        {view.quota.left > 0 ? (
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <label className="sr-only" htmlFor="invite-note">
              Who is it for?
            </label>
            <input
              id="invite-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Who is it for? (only you see this)"
              maxLength={120}
              className="border-border bg-surface min-w-0 flex-1 rounded-xl border px-3 py-2 text-sm"
            />
            <button
              type="button"
              onClick={create}
              disabled={busy}
              className="bg-accent rounded-xl px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
            >
              {busy ? 'Making…' : 'Make an invite'}
            </button>
          </div>
        ) : null}

        {fresh ? (
          <div className="border-border mt-3 rounded-xl border p-3">
            <p className="text-ink-muted text-xs">Send this link. It is shown only now.</p>
            <p className="mt-1 font-mono text-sm break-all select-all">{fresh}</p>
            <button type="button" onClick={() => copy(fresh)} className="mt-2 text-sm underline">
              {copied === fresh ? 'Copied' : 'Copy link'}
            </button>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-hot mt-2 text-sm">
            {error}
          </p>
        ) : null}

        {view.invites.length > 0 ? (
          <ul className="mt-4 flex flex-col gap-2 text-sm">
            {view.invites.map((invite) => (
              <li key={invite.id} className="flex justify-between gap-3">
                <span className="truncate">{invite.note || 'Invite'}</span>
                <span className="text-ink-muted shrink-0 text-xs">
                  {invite.revoked
                    ? 'withdrawn'
                    : invite.used
                      ? 'accepted'
                      : invite.expiresAt && Date.parse(invite.expiresAt) < Date.now()
                        ? 'expired'
                        : 'waiting'}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="border-border bg-surface-raised rounded-2xl border p-4">
        <h2 className="font-medium">Your link</h2>
        <p className="text-ink-muted mt-1 text-sm">
          Open and unlimited: anyone who signs up after following it is recorded as yours. It
          carries no bonus by itself.
        </p>
        <p className="mt-2 font-mono text-sm break-all select-all">{view.affiliateUrl}</p>
        <button
          type="button"
          onClick={() => copy(view.affiliateUrl)}
          className="mt-2 text-sm underline"
        >
          {copied === view.affiliateUrl ? 'Copied' : 'Copy link'}
        </button>
        {view.invitedCount > 0 ? (
          <p className="text-ink-muted mt-3 text-xs">
            {view.invitedCount} {view.invitedCount === 1 ? 'person has' : 'people have'} joined from
            your invites.
          </p>
        ) : null}
      </section>
    </div>
  );
}

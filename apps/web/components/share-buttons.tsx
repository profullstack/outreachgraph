'use client';

import { useState } from 'react';

interface ShareLinkView {
  readonly network: string;
  readonly label: string;
  readonly url: string;
  readonly text: string;
  readonly note?: string;
}

/**
 * One-click posts for the networks the product may not automate.
 *
 * Every button opens that network's own composer, prefilled, in a new tab. The
 * human reads it and posts it themselves — which is the only lawful way to use
 * LinkedIn and the terms-compliant way to use most of the others.
 *
 * Two details that are easy to get wrong and matter:
 *
 *   - The window is opened **synchronously in the click handler**. Opening it
 *     after an `await` gets it blocked as a popup in every browser, which is
 *     how a share button ends up appearing to do nothing.
 *   - The links are fetched lazily on first expand. Building composer URLs for
 *     twelve networks per card, on a list of fifty cards, is work nobody asked
 *     for.
 */
export function ShareButtons({ recommendationId }: { recommendationId: string }) {
  const [links, setLinks] = useState<ShareLinkView[] | undefined>();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [posted, setPosted] = useState<string[]>([]);

  async function expand() {
    if (open) {
      setOpen(false);
      return;
    }

    setOpen(true);
    if (links) return;

    setBusy(true);
    setError(undefined);

    try {
      const response = await fetch(
        `/api/v1/recommendations/${encodeURIComponent(recommendationId)}/share`,
        { credentials: 'same-origin' },
      );

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(payload?.error?.message ?? 'could not build the posts');
        return;
      }

      setLinks(payload.links ?? []);
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  function share(link: ShareLinkView) {
    // Opened first, before anything async. See the note above.
    window.open(link.url, '_blank', 'noopener,noreferrer');

    setPosted((current) => (current.includes(link.network) ? current : [...current, link.network]));

    // Recorded in the background. If this fails the post still happened, so it
    // must not be allowed to look like an error to the user.
    void fetch(`/api/v1/recommendations/${encodeURIComponent(recommendationId)}/share`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ network: link.network }),
    }).catch(() => undefined);
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={expand}
        className="text-ink-muted text-[13px] underline"
        aria-expanded={open}
      >
        {open ? 'Hide posting options' : 'Post this somewhere'}
      </button>

      {open ? (
        <div className="mt-2">
          {busy ? <p className="text-ink-muted text-[13px]">Building…</p> : null}

          {error ? (
            <p role="alert" className="text-hot text-[13px]">
              {error}
            </p>
          ) : null}

          {links ? (
            <>
              <div className="flex flex-wrap gap-2">
                {links.map((link) => (
                  <button
                    key={link.network}
                    type="button"
                    onClick={() => share(link)}
                    title={link.note ?? `Open ${link.label} with this message ready to post`}
                    className={`border-border rounded-xl border px-3 py-1.5 text-[13px] ${
                      posted.includes(link.network) ? 'text-ink-muted' : ''
                    }`}
                  >
                    {link.label}
                    {posted.includes(link.network) ? ' ✓' : ''}
                  </button>
                ))}
              </div>

              <p className="text-ink-muted mt-2 text-[11px] leading-relaxed">
                Opens the network with the message filled in. You post it — nothing is sent on your
                behalf.
              </p>

              {links.some((link) => link.note) ? (
                <ul className="text-ink-muted mt-1 text-[11px]">
                  {links
                    .filter((link) => link.note)
                    .map((link) => (
                      <li key={link.network}>
                        {link.label}: {link.note}
                      </li>
                    ))}
                </ul>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

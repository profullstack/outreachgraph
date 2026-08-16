'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { ListeningView, SubredditSuggestionView } from '../lib/types';

const SOURCE_LABELS: Record<string, { label: string; note: string }> = {
  reddit: {
    label: 'Reddit',
    note: 'The best coverage outside software. Scope it to the communities your buyers are in.',
  },
  rss: {
    label: 'RSS feeds',
    note: 'Trade press, local news, job boards, forums. A feed has no search, so the URLs are the targeting.',
  },
  bluesky: { label: 'Bluesky', note: 'Public post search. Skews technical for now.' },
  nostr: { label: 'Nostr', note: 'Relay search. Small, and mostly bitcoin-adjacent.' },
};

/**
 * Where this product listens (PRD §8, §11).
 *
 * Per campaign, because the whole value of listening is being in the right
 * room: an unscoped search for "invoicing" returns noise, while the same word
 * inside three trade subreddits returns people describing the problem they are
 * about to buy a solution for. Two products sold to two trades therefore need
 * two sets of communities, which is why this lives beside the product's
 * profile and not in the deployment's environment.
 *
 * The suggest button exists because the honest answer to "which subreddits?"
 * is usually "I don't know". Someone selling scheduling software to plumbing
 * contractors knows their buyer exactly and has still never heard of
 * r/Plumbing. Reddit indexes its own communities, so the product can answer
 * that from the keywords already collected during setup rather than handing
 * the research back to the person who bought it to avoid research.
 */
export function ListeningForm({ initial }: { initial: ListeningView }) {
  const router = useRouter();

  const [sources, setSources] = useState<string[]>(initial.sources);
  const [subreddits, setSubreddits] = useState<string[]>(initial.subreddits);
  const [feeds, setFeeds] = useState(initial.feeds.join('\n'));
  const [draft, setDraft] = useState('');

  const [suggestions, setSuggestions] = useState<SubredditSuggestionView[] | undefined>();
  const [busy, setBusy] = useState<'save' | 'suggest' | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);

  const on = (slug: string): boolean => sources.includes(slug);

  function toggle(slug: string): void {
    setSaved(false);
    setSources((current) =>
      current.includes(slug) ? current.filter((s) => s !== slug) : [...current, slug],
    );
  }

  function addSubreddit(name: string): void {
    const clean = name.trim().replace(/^\/?r\//i, '');
    if (clean === '') return;
    setSaved(false);
    setSubreddits((current) =>
      current.some((s) => s.toLowerCase() === clean.toLowerCase()) ? current : [...current, clean],
    );
    setDraft('');
  }

  async function suggest(): Promise<void> {
    setBusy('suggest');
    setError(undefined);

    try {
      const response = await fetch(
        `/api/v1/campaigns/${encodeURIComponent(initial.campaignId)}/listening/suggestions`,
        { credentials: 'same-origin' },
      );

      const payload = (await response.json().catch(() => ({}))) as {
        suggestions?: SubredditSuggestionView[];
        error?: { message?: string };
      };

      if (!response.ok) {
        setError(payload.error?.message ?? `that failed (${response.status})`);
        return;
      }

      setSuggestions(payload.suggestions ?? []);
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(undefined);
    }
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy('save');
    setError(undefined);
    setSaved(false);

    try {
      const response = await fetch(
        `/api/v1/campaigns/${encodeURIComponent(initial.campaignId)}/listening`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            sources,
            subreddits,
            feeds: feeds
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean),
          }),
        },
      );

      const payload = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
      };

      if (!response.ok) {
        setError(payload.error?.message ?? `that failed (${response.status})`);
        return;
      }

      setSaved(true);
      router.refresh();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <form onSubmit={submit} className="border-border bg-surface-raised rounded-2xl border p-4">
      <h2 className="text-sm font-semibold">Listen for buyers</h2>
      <p className="text-ink-muted mt-1 text-sm">
        Finds people from what they posted publicly, rather than from the company they work for.
        This is how you reach buyers with no engineering blog and no GitHub profile.
      </p>

      {initial.terms.length === 0 ? (
        <p className="border-border text-ink-muted mt-3 rounded-xl border border-dashed p-3 text-sm">
          Nothing to listen for yet — this product has no keywords or competitors. Fill in the
          profile above first.
        </p>
      ) : (
        <p className="text-ink-muted mt-3 text-sm">
          Searching for: <span className="text-ink">{initial.terms.join(', ')}</span>
        </p>
      )}

      <fieldset className="mt-4">
        <legend className="text-sm font-medium">Where to look</legend>
        <div className="mt-2 space-y-2">
          {initial.available.map((slug) => (
            <label key={slug} className="flex gap-2 text-sm">
              <input
                type="checkbox"
                checked={on(slug)}
                onChange={() => toggle(slug)}
                className="mt-1"
              />
              <span>
                <span className="font-medium">{SOURCE_LABELS[slug]?.label ?? slug}</span>
                <span className="text-ink-muted block text-xs">{SOURCE_LABELS[slug]?.note}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {on('reddit') && (
        <fieldset className="mt-4">
          <legend className="text-sm font-medium">Communities</legend>
          <p className="text-ink-muted mt-1 text-xs">
            Leave empty to search all of Reddit, which is usually noise. Three trade subreddits beat
            the whole site.
          </p>

          {subreddits.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-2">
              {subreddits.map((name) => (
                <li
                  key={name}
                  className="border-border flex items-center gap-1 rounded-full border px-3 py-1 text-xs"
                >
                  r/{name}
                  <button
                    type="button"
                    aria-label={`Remove r/${name}`}
                    className="text-ink-muted hover:text-ink"
                    onClick={() => {
                      setSaved(false);
                      setSubreddits((current) => current.filter((s) => s !== name));
                    }}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-2 flex gap-2">
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                // Enter adds a community; it must not submit the whole form
                // and save a half-typed name.
                event.preventDefault();
                addSubreddit(draft);
              }}
              placeholder="r/plumbing"
              className="border-border flex-1 rounded-xl border px-3 py-2 text-sm"
            />
            <button
              type="button"
              onClick={() => addSubreddit(draft)}
              className="border-border rounded-xl border px-3 py-2 text-sm"
            >
              Add
            </button>
            <button
              type="button"
              onClick={suggest}
              disabled={busy !== undefined || initial.terms.length === 0}
              className="border-border rounded-xl border px-3 py-2 text-sm disabled:opacity-50"
            >
              {busy === 'suggest' ? 'Looking…' : 'Suggest'}
            </button>
          </div>

          {suggestions?.length === 0 && (
            <p className="text-ink-muted mt-2 text-xs">
              No communities matched those keywords. Try adding a subreddit by hand.
            </p>
          )}

          {suggestions !== undefined && suggestions.length > 0 && (
            <ul className="mt-3 space-y-2">
              {suggestions.map((suggestion) => (
                <li key={suggestion.name} className="flex items-start justify-between gap-3">
                  <span className="text-sm">
                    <a
                      href={suggestion.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="font-medium underline"
                    >
                      r/{suggestion.name}
                    </a>
                    <span className="text-ink-muted block text-xs">
                      {suggestion.subscribers.toLocaleString()} members
                      {suggestion.description ? ` · ${suggestion.description.slice(0, 90)}` : ''}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => addSubreddit(suggestion.name)}
                    className="border-border shrink-0 rounded-xl border px-2 py-1 text-xs"
                  >
                    Add
                  </button>
                </li>
              ))}
            </ul>
          )}
        </fieldset>
      )}

      {on('rss') && (
        <fieldset className="mt-4">
          <legend className="text-sm font-medium">Feed URLs</legend>
          <p className="text-ink-muted mt-1 text-xs">One per line.</p>
          <textarea
            value={feeds}
            onChange={(event) => {
              setFeeds(event.target.value);
              setSaved(false);
            }}
            rows={4}
            placeholder="https://example.com/feed.xml"
            className="border-border mt-2 w-full rounded-xl border px-3 py-2 font-mono text-xs"
          />
        </fieldset>
      )}

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <div className="mt-4 flex items-center gap-3">
        <button
          type="submit"
          disabled={busy !== undefined}
          className="bg-ink text-surface rounded-xl px-4 py-2 text-sm disabled:opacity-50"
        >
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>
        {saved && <span className="text-ink-muted text-sm">Saved.</span>}
      </div>

      <p className="text-ink-muted mt-3 text-xs">
        People found this way are recorded with low identity confidence — a username is not a name,
        a company or an address — so they sit below the workspace’s outreach floor and nothing is
        sent to them until they are resolved to a real identity.
      </p>
    </form>
  );
}

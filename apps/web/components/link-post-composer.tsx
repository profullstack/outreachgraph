'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  LINK_POST_FORMATS,
  LINK_POST_NETWORKS,
  linkPostBodyFromText,
  linkPostCard,
  type LinkPostNetwork,
} from '@outreachgraph/domain';
import type { LinkPostView, SavedLinkView } from '../lib/api';
import type { ProductSummaryView } from '../lib/types';

/**
 * "Draft a post from a link": paste a URL, pick networks, get a hand-off card
 * per network.
 *
 * The API reads the page and writes each post in the workspace's voice, sized
 * to the network. Every card is posted by a person: Copy, Open the network's
 * composer (prefilled where the network allows it), paste, Mark done. Edits
 * stay in the box and rebuild the Open link, so what opens is what was edited.
 */
export function LinkPostComposer({
  initialPosts,
  initialLinks,
  products,
  draftingEnabled,
}: {
  initialPosts: LinkPostView[];
  initialLinks: SavedLinkView[];
  products: ProductSummaryView[];
  draftingEnabled: boolean;
}) {
  const router = useRouter();
  const [posts, setPosts] = useState<LinkPostView[]>(initialPosts);
  const [url, setUrl] = useState('');
  const [links, setLinks] = useState<SavedLinkView[]>(initialLinks);
  const [networks, setNetworks] = useState<LinkPostNetwork[]>(['linkedin']);
  const [offeringId, setOfferingId] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();

  const configured = products.filter((product) => product.configured);

  function toggle(network: LinkPostNetwork): void {
    setNetworks((current) =>
      current.includes(network)
        ? current.filter((n) => n !== network)
        : LINK_POST_NETWORKS.filter((n) => n === network || current.includes(n)),
    );
  }

  async function forget(link: string): Promise<void> {
    setLinks((current) => current.filter((item) => item.url !== link));
    await fetch(`/api/v1/link-posts/links?url=${encodeURIComponent(link)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    }).catch(() => undefined);
  }

  async function draft(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!url.trim() || networks.length === 0) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await fetch('/api/v1/link-posts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          url: url.trim(),
          networks,
          ...(offeringId ? { offeringId } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        posts?: LinkPostView[];
        missing?: string[];
        page?: { read: boolean; url?: string; title?: string };
        error?: { message?: string };
      };
      if (!response.ok || !payload.posts) {
        setError(payload.error?.message ?? `that failed (${response.status})`);
        return;
      }
      setPosts((current) => [...payload.posts!, ...current]);
      // Every link drafted from is kept; put it at the top of the picker.
      const used = payload.page?.url ?? url.trim();
      setLinks((current) => [
        {
          url: used,
          ...(payload.page?.title ? { title: payload.page.title } : {}),
          lastUsedAt: new Date().toISOString(),
        },
        ...current.filter((link) => link.url !== used),
      ]);
      setUrl('');
      const parts: string[] = [];
      if (payload.page && !payload.page.read) {
        parts.push('The page could not be read, so the posts are written from your notes.');
      }
      if (payload.missing?.length) {
        parts.push(
          `Nothing came back for ${payload.missing.map(labelOf).join(', ')}; try Draft again.`,
        );
      }
      if (parts.length) setNotice(parts.join(' '));
      router.refresh();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  const batches = groupByBatch(posts);

  return (
    <section className="mb-6 flex flex-col gap-3">
      <form
        onSubmit={(event) => void draft(event)}
        className="border-border bg-surface-raised rounded-2xl border p-4"
      >
        <h2 className="text-base font-semibold">Draft a post from a link</h2>
        <p className="text-ink-muted text-sm">
          Paste a link. Each network gets its own post in your voice, ready to copy and post.
        </p>

        <input
          type="url"
          inputMode="url"
          required
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://"
          aria-label="Link to post about"
          className="border-border bg-surface mt-3 w-full rounded-xl border px-3 py-2 text-sm"
        />

        {links.length > 0 ? (
          <ul
            aria-label="Links you have posted about"
            className="border-border mt-2 max-h-48 overflow-y-auto rounded-xl border text-sm"
          >
            {links.map((link) => (
              <li
                key={link.url}
                className={`border-border flex items-center gap-2 border-b px-3 py-1.5 last:border-b-0 ${
                  link.url === url ? 'bg-surface' : ''
                }`}
              >
                <button
                  type="button"
                  onClick={() => setUrl(link.url)}
                  title={link.url}
                  className="min-w-0 flex-1 truncate text-left"
                >
                  {link.title ? `${link.title} · ` : ''}
                  <span className="text-ink-muted">{link.url}</span>
                </button>
                <button
                  type="button"
                  onClick={() => void forget(link.url)}
                  aria-label={`Remove ${link.url}`}
                  className="text-ink-muted hover:text-hot px-1"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <fieldset className="mt-3">
          <legend className="text-ink-muted mb-1 text-xs">Networks</legend>
          <div className="flex flex-wrap gap-2">
            {LINK_POST_NETWORKS.map((network) => {
              const on = networks.includes(network);
              return (
                <button
                  key={network}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(network)}
                  className={`rounded-full border px-3 py-1 text-sm ${
                    on ? 'border-accent bg-accent text-white' : 'border-border'
                  }`}
                >
                  {labelOf(network)}
                </button>
              );
            })}
          </div>
        </fieldset>

        <details className="text-ink-muted mt-3 text-sm">
          <summary className="cursor-pointer">Voice and notes (optional)</summary>
          {configured.length > 1 ? (
            <label className="mt-2 block text-xs">
              Write as
              <select
                value={offeringId}
                onChange={(event) => setOfferingId(event.target.value)}
                className="border-border bg-surface mt-1 block w-full rounded-xl border px-3 py-2 text-sm"
              >
                <option value="">The product whose site the link is on (else the first)</option>
                {configured.map((product) => (
                  <option key={product.offeringId} value={product.offeringId}>
                    {product.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={2}
            maxLength={1000}
            placeholder="An angle, a call to action, what to leave out…"
            aria-label="Notes for the writer"
            className="border-border bg-surface mt-2 w-full rounded-xl border px-3 py-2 text-sm"
          />
        </details>

        {error ? (
          <p role="alert" className="text-hot mt-2 text-sm">
            {error}
          </p>
        ) : null}
        {notice ? <p className="text-ink-muted mt-2 text-sm">{notice}</p> : null}

        <button
          type="submit"
          disabled={busy || !draftingEnabled || networks.length === 0 || !url.trim()}
          className="bg-accent mt-3 w-full rounded-xl py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {busy
            ? 'Reading the page and writing…'
            : draftingEnabled
              ? `Draft ${networks.length} post${networks.length === 1 ? '' : 's'}`
              : 'Drafting is off: no model is configured'}
        </button>
      </form>

      {batches.map((batch) => (
        <div key={batch.id} className="flex flex-col gap-3">
          <p className="text-ink-muted truncate text-xs">
            {batch.title ? `${batch.title} · ` : ''}
            <a href={batch.url} target="_blank" rel="noopener noreferrer" className="underline">
              {batch.url}
            </a>
          </p>
          {batch.posts.map((post) => (
            <LinkPostCard
              key={post.id}
              post={post}
              onGone={() => setPosts((current) => current.filter((p) => p.id !== post.id))}
              onChange={(next) =>
                setPosts((current) => current.map((p) => (p.id === next.id ? next : p)))
              }
              draftingEnabled={draftingEnabled}
            />
          ))}
        </div>
      ))}
    </section>
  );
}

function labelOf(network: string): string {
  return (
    (LINK_POST_FORMATS as Record<string, { label: string } | undefined>)[network]?.label ?? network
  );
}

function groupByBatch(posts: LinkPostView[]) {
  const batches: { id: string; url: string; title?: string; posts: LinkPostView[] }[] = [];
  for (const post of posts) {
    const batch = batches.find((b) => b.id === post.batchId);
    if (batch) batch.posts.push(post);
    else
      batches.push({
        id: post.batchId,
        url: post.url,
        ...(post.pageTitle ? { title: post.pageTitle } : {}),
        posts: [post],
      });
  }
  return batches;
}

function LinkPostCard({
  post,
  onGone,
  onChange,
  draftingEnabled,
}: {
  post: LinkPostView;
  onGone: () => void;
  onChange: (post: LinkPostView) => void;
  draftingEnabled: boolean;
}) {
  const router = useRouter();
  const titled = LINK_POST_FORMATS[post.network].titled;
  const [text, setText] = useState(post.text);
  const [title, setTitle] = useState(post.title ?? '');
  const [copied, setCopied] = useState<'text' | 'title' | undefined>();
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState<'done' | 'skip' | 'regenerate' | undefined>();
  const [error, setError] = useState<string | undefined>();

  // Rebuilt on every edit, so Open carries what is in the box.
  const view = linkPostCard({
    network: post.network,
    url: post.url,
    body: linkPostBodyFromText(post.network, text, post.url),
    title,
    subreddit: post.subreddit,
    mastodonInstance: post.mastodonInstance,
  });

  async function copy(which: 'text' | 'title'): Promise<void> {
    setError(undefined);
    try {
      await navigator.clipboard.writeText(which === 'title' ? title : text);
      setCopied(which);
      setTimeout(() => setCopied(undefined), 2000);
    } catch {
      setError('Copy was blocked here. Select the text and copy it yourself.');
    }
  }

  async function send(
    kind: 'done' | 'skip' | 'regenerate',
    body: Record<string, unknown>,
  ): Promise<LinkPostView | undefined> {
    setBusy(kind);
    setError(undefined);
    try {
      const response = await fetch(`/api/v1/link-posts/${encodeURIComponent(post.id)}/${kind}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        post?: LinkPostView;
        error?: { message?: string };
      };
      if (!response.ok || !payload.post) {
        setError(payload.error?.message ?? `that failed (${response.status})`);
        return undefined;
      }
      return payload.post;
    } catch {
      setError('could not reach the server');
      return undefined;
    } finally {
      setBusy(undefined);
    }
  }

  async function finish(kind: 'done' | 'skip'): Promise<void> {
    const trimmed = link.trim();
    const result = await send(
      kind,
      kind === 'done'
        ? {
            text,
            ...(titled ? { title } : {}),
            ...(/^https?:\/\//i.test(trimmed) ? { postedUrl: trimmed } : {}),
          }
        : {},
    );
    if (result) {
      onGone();
      router.refresh();
    }
  }

  async function regenerate(): Promise<void> {
    const result = await send('regenerate', {});
    if (result) {
      setText(result.text);
      setTitle(result.title ?? '');
      onChange(result);
    }
  }

  const count = (
    <p
      className={`text-right text-xs tabular-nums ${view.overLimit ? 'text-hot' : 'text-ink-muted'}`}
    >
      {view.chars.toLocaleString()}
      {view.limit ? ` / ${view.limit.toLocaleString()}` : ''} chars
      {view.overLimit ? ' (over the limit)' : ''}
    </p>
  );

  return (
    <article className="border-border bg-surface-raised rounded-2xl border p-4">
      <header className="min-w-0">
        <h2 className="truncate text-base font-semibold">
          Post on {view.label}
          {view.subreddit ? <span className="text-ink-muted"> · r/{view.subreddit}</span> : null}
        </h2>
        {post.pageTitle ? (
          <p className="text-ink-muted truncate text-sm">{post.pageTitle}</p>
        ) : null}
      </header>

      {titled ? (
        <section className="mt-3">
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            aria-label="Title"
            className="border-border bg-surface w-full rounded-xl border px-3 py-2 text-sm font-medium"
          />
          {count}
        </section>
      ) : null}

      <section className="mt-3">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={titled ? 3 : post.network === 'linkedin' ? 9 : 5}
          placeholder={titled ? 'First comment (optional)' : 'Write the post.'}
          aria-label={titled ? 'First comment' : 'Text to paste'}
          className="border-border bg-surface w-full rounded-xl border px-3 py-3 font-mono text-[13px]"
        />
        {titled ? (
          <p className="text-ink-muted text-right text-xs tabular-nums">
            {[...text].length.toLocaleString()} chars
          </p>
        ) : (
          count
        )}
      </section>

      <div className="mt-3 grid grid-cols-2 gap-2">
        {titled ? (
          <button
            type="button"
            onClick={() => void copy('title')}
            disabled={title.length === 0}
            className="border-border rounded-xl border py-2 text-sm font-medium disabled:opacity-50"
          >
            {copied === 'title' ? 'Copied' : 'Copy title'}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void copy('text')}
          disabled={text.length === 0}
          className="border-border rounded-xl border py-2 text-sm font-medium disabled:opacity-50"
        >
          {copied === 'text' ? 'Copied' : titled ? 'Copy comment' : 'Copy'}
        </button>
        {view.openUrl ? (
          <a
            href={view.openUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={`bg-accent rounded-xl py-2 text-center text-sm font-medium text-white ${
              titled ? 'col-span-2' : ''
            }`}
          >
            {view.openLabel}
          </a>
        ) : null}
      </div>

      <ol className="text-ink-muted mt-3 list-decimal pl-5 text-sm">
        {view.steps.map((step) => (
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

      <div className="mt-3 grid grid-cols-3 gap-2">
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
          onClick={() => void regenerate()}
          disabled={busy !== undefined || !draftingEnabled}
          className="border-border rounded-xl border py-2 text-sm font-medium disabled:opacity-60"
        >
          {busy === 'regenerate' ? 'Writing…' : 'Regenerate'}
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

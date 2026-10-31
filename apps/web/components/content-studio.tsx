'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type {
  ContentDraftKind,
  ContentDraftStatus,
  ContentDraftView,
  ContentStudioView,
} from '../lib/api';
import type { ProductSummaryView } from '../lib/types';

const KIND_LABELS: Record<ContentDraftKind, string> = {
  social: 'LinkedIn post',
  newsletter: 'Newsletter',
  article: 'Blog article',
};

const STATUS_LABELS: Record<ContentDraftStatus, string> = {
  draft: 'Draft',
  ready: 'Reviewed',
  archived: 'Archived',
};

export function ContentStudio({
  initial,
  products,
}: {
  initial: ContentStudioView;
  products: ProductSummaryView[];
}) {
  const router = useRouter();
  const [drafts, setDrafts] = useState(initial.drafts);
  const [kind, setKind] = useState<ContentDraftKind>('social');
  const [topic, setTopic] = useState('');
  const [audience, setAudience] = useState('');
  const [notes, setNotes] = useState('');
  const [offeringId, setOfferingId] = useState(products[0]?.offeringId ?? '');
  const [filter, setFilter] = useState<'active' | ContentDraftKind | 'archived'>('active');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const visible = drafts.filter((draft) =>
    filter === 'active'
      ? draft.status !== 'archived'
      : filter === 'archived'
        ? draft.status === 'archived'
        : draft.kind === filter && draft.status !== 'archived',
  );

  async function generate(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!topic.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch('/api/v1/content-drafts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          kind,
          topic: topic.trim(),
          ...(audience.trim() ? { audience: audience.trim() } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          ...(offeringId ? { offeringId } : {}),
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        draft?: ContentDraftView;
        error?: { message?: string };
      };
      if (!response.ok || !payload.draft) {
        setError(payload.error?.message ?? `could not draft that (${response.status})`);
        return;
      }
      setDrafts((current) => [payload.draft!, ...current]);
      setTopic('');
      setNotes('');
      setFilter('active');
      router.refresh();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  async function update(
    id: string,
    changes: Partial<Pick<ContentDraftView, 'title' | 'body' | 'status'>>,
  ): Promise<void> {
    const response = await fetch(`/api/v1/content-drafts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(changes),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      draft?: ContentDraftView;
      error?: { message?: string };
    };
    if (!response.ok || !payload.draft) {
      throw new Error(payload.error?.message ?? `save failed (${response.status})`);
    }
    setDrafts((current) => current.map((draft) => (draft.id === id ? payload.draft! : draft)));
  }

  async function remove(id: string): Promise<void> {
    const response = await fetch(`/api/v1/content-drafts/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error(`delete failed (${response.status})`);
    setDrafts((current) => current.filter((draft) => draft.id !== id));
  }

  return (
    <div className="space-y-5 pb-8">
      <header className="pt-4">
        <p className="text-ink-muted font-mono text-[11px] tracking-[0.14em] uppercase">
          Content studio
        </p>
        <h1 className="mt-1 text-xl font-semibold">Write once. Stay visible.</h1>
        <p className="text-ink-muted mt-1 text-sm">
          Draft posts, newsletters, and articles in your product’s saved voice. Review and publish
          them yourself.
        </p>
      </header>

      <form
        onSubmit={(event) => void generate(event)}
        className="border-border bg-surface-raised space-y-3 rounded-2xl border p-4"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-ink-muted block text-xs">
            Format
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value as ContentDraftKind)}
              className="border-border bg-surface mt-1 block w-full rounded-xl border px-3 py-2.5 text-sm text-ink"
            >
              <option value="social">LinkedIn post</option>
              <option value="newsletter">Newsletter issue</option>
              <option value="article">Blog article</option>
            </select>
          </label>
          {products.length > 0 ? (
            <label className="text-ink-muted block text-xs">
              Product voice
              <select
                value={offeringId}
                onChange={(event) => setOfferingId(event.target.value)}
                className="border-border bg-surface mt-1 block w-full rounded-xl border px-3 py-2.5 text-sm text-ink"
              >
                {products.map((product) => (
                  <option key={product.offeringId} value={product.offeringId}>
                    {product.name}
                    {product.configured ? '' : ' · voice not set up'}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>

        <label className="text-ink-muted block text-xs">
          What should this be about?
          <input
            required
            minLength={3}
            maxLength={240}
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            placeholder="A lesson from talking to our first 20 customers"
            className="border-border bg-surface mt-1 w-full rounded-xl border px-3 py-2.5 text-sm text-ink"
          />
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-ink-muted block text-xs">
            Who is it for? <span className="opacity-70">optional</span>
            <input
              maxLength={500}
              value={audience}
              onChange={(event) => setAudience(event.target.value)}
              placeholder="Founders building a small sales team"
              className="border-border bg-surface mt-1 w-full rounded-xl border px-3 py-2.5 text-sm text-ink"
            />
          </label>
          <label className="text-ink-muted block text-xs">
            Notes or facts to use <span className="opacity-70">optional</span>
            <textarea
              maxLength={4000}
              rows={3}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Specific examples, points to include, or claims to avoid"
              className="border-border bg-surface mt-1 w-full rounded-xl border px-3 py-2 text-sm text-ink"
            />
          </label>
        </div>

        {error ? (
          <p role="alert" className="text-hot text-sm">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={busy || !initial.draftingEnabled || topic.trim().length < 3}
          className="bg-accent w-full rounded-xl py-2.5 text-sm font-medium text-white disabled:opacity-60"
        >
          {busy
            ? 'Writing…'
            : initial.draftingEnabled
              ? `Draft ${KIND_LABELS[kind].toLowerCase()}`
              : 'Drafting is off: no model is configured'}
        </button>
      </form>

      <div className="border-border flex gap-2 overflow-x-auto border-b pb-2 text-sm">
        {(
          [
            ['active', 'All drafts'],
            ['social', 'Social'],
            ['newsletter', 'Newsletters'],
            ['article', 'Articles'],
            ['archived', 'Archived'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
            className={`shrink-0 rounded-full border px-3 py-1.5 ${
              filter === value
                ? 'border-accent bg-accent text-white'
                : 'border-border text-ink-muted'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {visible.length ? (
        <div className="space-y-3">
          {visible.map((draft) => (
            <DraftCard key={draft.id} draft={draft} onUpdate={update} onDelete={remove} />
          ))}
        </div>
      ) : (
        <p className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
          Your saved drafts will show up here.
        </p>
      )}

      <p className="text-ink-muted text-center text-xs">
        Need a quick wording check?{' '}
        <Link className="text-accent underline" href="/tools/content-checker">
          Open the free AI-speak checker
        </Link>
        .
      </p>
    </div>
  );
}

function DraftCard({
  draft,
  onUpdate,
  onDelete,
}: {
  draft: ContentDraftView;
  onUpdate: (
    id: string,
    changes: Partial<Pick<ContentDraftView, 'title' | 'body' | 'status'>>,
  ) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [title, setTitle] = useState(draft.title);
  const [body, setBody] = useState(draft.body);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function act(action: () => Promise<void>, success: string): Promise<void> {
    setBusy(true);
    setMessage('');
    try {
      await action();
      setMessage(success);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'could not save');
    } finally {
      setBusy(false);
    }
  }

  const nextStatus: ContentDraftStatus =
    draft.status === 'draft' ? 'ready' : draft.status === 'ready' ? 'draft' : 'draft';

  return (
    <article className="border-border bg-surface-raised rounded-2xl border p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-ink-muted text-[11px] font-medium uppercase">
            {KIND_LABELS[draft.kind]} · {STATUS_LABELS[draft.status]}
          </p>
          <p className="text-ink-muted mt-0.5 truncate text-xs">{draft.topic}</p>
        </div>
        {draft.model ? (
          <span className="text-ink-muted shrink-0 font-mono text-[10px]">{draft.model}</span>
        ) : null}
      </div>
      <label className="sr-only" htmlFor={`title-${draft.id}`}>
        Draft title
      </label>
      <input
        id={`title-${draft.id}`}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        maxLength={240}
        className="border-border bg-surface mb-2 w-full rounded-xl border px-3 py-2 text-base font-semibold"
      />
      <label className="sr-only" htmlFor={`body-${draft.id}`}>
        Draft copy
      </label>
      <textarea
        id={`body-${draft.id}`}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        maxLength={20_000}
        rows={draft.kind === 'article' ? 18 : draft.kind === 'newsletter' ? 12 : 8}
        className="border-border bg-surface w-full resize-y rounded-xl border px-3 py-2.5 text-sm leading-relaxed"
      />
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void act(() => onUpdate(draft.id, { title, body }), 'Saved')}
          className="bg-accent rounded-lg px-3 py-2 text-xs font-medium text-white disabled:opacity-60"
        >
          Save edits
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void act(
              () => onUpdate(draft.id, { title, body, status: nextStatus }),
              nextStatus === 'ready' ? 'Marked reviewed' : 'Moved to drafts',
            )
          }
          className="border-border rounded-lg border px-3 py-2 text-xs"
        >
          {draft.status === 'draft'
            ? 'Mark reviewed'
            : draft.status === 'ready'
              ? 'Move to drafts'
              : 'Restore'}
        </button>
        <button
          type="button"
          onClick={() =>
            void act(async () => {
              await navigator.clipboard.writeText(`${title}\n\n${body}`);
            }, 'Copied for manual publishing')
          }
          className="border-border rounded-lg border px-3 py-2 text-xs"
        >
          Copy
        </button>
        {draft.status !== 'archived' ? (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void act(() => onUpdate(draft.id, { title, body, status: 'archived' }), 'Archived')
            }
            className="text-ink-muted rounded-lg px-2 py-2 text-xs"
          >
            Archive
          </button>
        ) : null}
        <button
          type="button"
          disabled={busy}
          onClick={() => void act(() => onDelete(draft.id), 'Deleted')}
          className="text-hot rounded-lg px-2 py-2 text-xs"
        >
          Delete
        </button>
      </div>
      {message ? (
        <p aria-live="polite" className="text-ink-muted mt-2 text-xs">
          {message}
        </p>
      ) : null}
    </article>
  );
}

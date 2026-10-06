'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { IdeaAskView, IdeaView, IdeasView } from '../lib/api';

/**
 * The idea list: scan, read the posts behind an idea, build it.
 *
 * Every write goes through `/api/v1/ideas` and refreshes the page. Build it
 * returns chovy.com's link, which opens Chovy's intake with the idea filled in;
 * it opens in a new tab and stays on the idea for later.
 */
export function IdeasBoard({ initial }: { initial: IdeasView }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [open, setOpen] = useState<string | undefined>();
  const [asks, setAsks] = useState<Record<string, IdeaAskView[]>>({});

  async function call(
    key: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown> | undefined> {
    setBusy(key);
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await fetch(`/api/v1/ideas${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown> & {
        error?: { message?: string };
      };
      if (!response.ok) {
        setError(payload.error?.message ?? `that failed (${response.status})`);
        return undefined;
      }
      router.refresh();
      return payload;
    } catch {
      setError('the API did not answer');
      return undefined;
    } finally {
      setBusy(undefined);
    }
  }

  async function scan() {
    const res = await call('scan', 'POST', '/scan', {});
    const r = res?.result as
      | { read: number; found: number; rejected: number; flagged: string[]; judged: boolean }
      | undefined;
    if (r)
      setNotice(
        `Read ${r.read} posts: ${r.found} new asks, ${r.rejected} pitches dropped, ${r.flagged.length} idea(s) ready to build.`,
      );
  }

  async function toggle(idea: IdeaView) {
    if (open === idea.id) return setOpen(undefined);
    setOpen(idea.id);
    if (!asks[idea.id]) {
      const res = await fetch(`/api/v1/ideas/${idea.id}`, { credentials: 'same-origin' });
      if (res.ok) {
        const body = (await res.json()) as { idea: { asksList: IdeaAskView[] } };
        setAsks((prev) => ({ ...prev, [idea.id]: body.idea.asksList }));
      }
    }
  }

  async function build(idea: IdeaView) {
    const res = await call(`build:${idea.id}`, 'POST', `/${idea.id}/build`);
    const url = res?.handoffUrl as string | undefined;
    if (url) {
      window.open(url, '_blank', 'noopener');
      setNotice(`Handed to chovy.com. If it did not open: ${url}`);
    }
  }

  const s = initial.settings;
  const ready = initial.ideas.filter((i) => i.status === 'build').length;

  return (
    <div className="space-y-4">
      <section className="border-border bg-surface flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-4">
        <div className="text-sm">
          <div className="font-medium">
            {initial.ideas.length} idea{initial.ideas.length === 1 ? '' : 's'}
            {ready ? ` · ${ready} ready to build` : ''}
          </div>
          <div className="text-ink-muted">
            {s.subs.length} subreddits · {s.feeds.length} feeds · flagged at {s.buildAt} people in{' '}
            {s.windowDays} days ·{' '}
            {s.lastScannedAt
              ? `last scan ${new Date(s.lastScannedAt).toLocaleString()}`
              : 'never scanned'}
            {initial.judgeEnabled ? '' : ' · pattern matching only (no model)'}
          </div>
        </div>
        <button
          type="button"
          onClick={scan}
          disabled={busy === 'scan'}
          className="bg-accent rounded-xl px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {busy === 'scan' ? 'Scanning… (about a minute)' : 'Scan now'}
        </button>
      </section>

      {error ? (
        <p className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="border-border bg-surface rounded-xl border p-3 text-sm">{notice}</p>
      ) : null}

      {initial.ideas.length === 0 ? (
        <p className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
          No ideas yet. Scan now reads{' '}
          {s.subs
            .slice(0, 4)
            .map((x) => `r/${x}`)
            .join(', ')}
          , Ask HN, founder case studies and more for things people want and pay for.
        </p>
      ) : (
        <ul className="space-y-3">
          {initial.ideas.map((idea) => (
            <li key={idea.id} className="border-border bg-surface rounded-2xl border p-4">
              <div className="flex items-start justify-between gap-3">
                <button
                  type="button"
                  onClick={() => toggle(idea)}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="font-medium">{idea.label}</div>
                  <div className="text-ink-muted text-sm">
                    {idea.askers} {idea.askers === 1 ? 'person' : 'people'} asked ·{' '}
                    {[...idea.subs.map((x) => `r/${x}`), ...idea.feeds].join(', ')} · last{' '}
                    {new Date(idea.lastAt).toLocaleDateString()}
                  </div>
                  <div className="text-ink-muted text-sm">
                    Worth {idea.worth}
                    {idea.paid
                      ? ` · ${idea.paid} source${idea.paid === 1 ? '' : 's'} showing money`
                      : ' · no proof of payment yet'}
                    {idea.revenue.length ? ` (${idea.revenue.slice(0, 2).join(', ')})` : ''}
                    {idea.rivals.length
                      ? ` · ${idea.rivals.length} similar launch${idea.rivals.length === 1 ? '' : 'es'}`
                      : ''}
                  </div>
                  {idea.wants.length ? (
                    <div className="text-ink-muted mt-1 text-sm">
                      Wants: {idea.wants.slice(0, 4).join('; ')}
                    </div>
                  ) : null}
                </button>
                <div className="flex shrink-0 flex-col items-end gap-2">
                  <span
                    title="build: wanted and paid for · validate: one of the two · crowded: 4+ similar launches"
                    className={`rounded-full px-2 py-0.5 text-xs ${
                      idea.verdict === 'build'
                        ? 'bg-green-100 text-green-800'
                        : idea.verdict === 'crowded'
                          ? 'bg-amber-100 text-amber-800'
                          : 'bg-border/60 text-ink-muted'
                    }`}
                  >
                    {idea.verdict === 'build' ? 'worth building' : idea.verdict}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs ${
                      idea.status === 'build'
                        ? 'bg-accent/15 text-accent'
                        : idea.status === 'building'
                          ? 'bg-blue-100 text-blue-800'
                          : 'bg-border/60 text-ink-muted'
                    }`}
                  >
                    {idea.status === 'build' ? 'ready to build' : idea.status}
                  </span>
                  {idea.status === 'building' && idea.handoffUrl ? (
                    <a
                      href={idea.handoffUrl}
                      target="_blank"
                      rel="noopener"
                      className="text-accent text-sm underline"
                    >
                      Open in chovy
                    </a>
                  ) : (
                    <button
                      type="button"
                      onClick={() => build(idea)}
                      disabled={!initial.buildEnabled || busy === `build:${idea.id}`}
                      title={
                        initial.buildEnabled
                          ? 'Hand this idea to chovy.com to build'
                          : 'Build it is not connected on this server'
                      }
                      className="border-border rounded-xl border px-3 py-1.5 text-sm font-medium disabled:opacity-50"
                    >
                      {busy === `build:${idea.id}` ? 'Handing off…' : 'Build it'}
                    </button>
                  )}
                </div>
              </div>

              {open === idea.id ? (
                <div className="border-border mt-3 space-y-2 border-t pt-3">
                  {(asks[idea.id] ?? []).map((a) => (
                    <a
                      key={a.id}
                      href={a.url}
                      target="_blank"
                      rel="noopener"
                      className="hover:bg-border/30 block rounded-lg p-2 text-sm"
                    >
                      <div>{a.title}</div>
                      <div className="text-ink-muted text-xs">
                        {a.source === 'feed' ? a.sub : `r/${a.sub} · u/${a.author}`} ·{' '}
                        {new Date(a.postedAt).toLocaleDateString()}
                        {a.revenue ? ` · ${a.revenue}` : a.paid ? ' · would pay' : ''}
                        {a.postScore != null ? ` · ${a.postScore} points` : ''}
                        {a.comments != null ? ` · ${a.comments} comments` : ''}
                      </div>
                    </a>
                  ))}
                  {idea.rivals.length ? (
                    <div className="text-ink-muted pt-1 text-xs">
                      Similar launches:{' '}
                      {idea.rivals.slice(0, 5).map((r, i) => (
                        <span key={r.url}>
                          {i ? ' · ' : ''}
                          <a href={r.url} target="_blank" rel="noopener" className="underline">
                            {r.title.replace(/^Show HN:\s*/i, '')}
                          </a>
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {asks[idea.id] === undefined ? (
                    <p className="text-ink-muted text-sm">Loading the posts…</p>
                  ) : null}
                  <div className="flex gap-2 pt-1">
                    {idea.status !== 'dismissed' ? (
                      <button
                        type="button"
                        onClick={() =>
                          call(`dismiss:${idea.id}`, 'PATCH', `/${idea.id}`, {
                            status: 'dismissed',
                          })
                        }
                        className="text-ink-muted text-xs underline"
                      >
                        Dismiss
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { JobPostView, JobPostsView } from '../lib/api';

interface CampaignOption {
  readonly id: string;
  readonly name: string;
}

/**
 * The job-post list: add by keyword or URL, then work each posting.
 *
 * Every write goes through `/api/v1/job-posts` and refreshes the page, so the
 * list on screen is always the server's. "Find people" runs the read and the
 * search inline because that is the moment somebody is waiting for an answer;
 * a posting added in bulk is resolved by the worker instead.
 */
export function JobPostsBoard({
  initial,
  campaigns,
}: {
  initial: JobPostsView;
  campaigns: readonly CampaignOption[];
}) {
  const router = useRouter();
  const [keyword, setKeyword] = useState('');
  const [urls, setUrls] = useState('');
  const [campaignId, setCampaignId] = useState('');
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [open, setOpen] = useState<string | undefined>();

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
      const response = await fetch(`/api/v1/job-posts${path}`, {
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
        router.refresh();
        return undefined;
      }
      router.refresh();
      return payload;
    } catch {
      setError('could not reach the server');
      return undefined;
    } finally {
      setBusy(undefined);
    }
  }

  async function search(event: FormEvent): Promise<void> {
    event.preventDefault();
    const result = await call('search', 'POST', '/search', {
      keyword,
      ...(campaignId ? { campaignId } : {}),
    });
    if (result) {
      const saved = Array.isArray(result.saved) ? result.saved.length : 0;
      setNotice(
        `Found ${String(result.found ?? 0)} posting(s), ${saved} new. Finding their people now.`,
      );
      setKeyword('');
    }
  }

  async function add(event: FormEvent): Promise<void> {
    event.preventDefault();
    const list = urls
      .split(/\s+/)
      .map((u) => u.trim())
      .filter(Boolean);
    const result = await call('add', 'POST', '', {
      urls: list,
      ...(campaignId ? { campaignId } : {}),
    });
    if (result) {
      const saved = Array.isArray(result.saved) ? result.saved.length : 0;
      const rejected = Array.isArray(result.rejected) ? result.rejected.length : 0;
      setNotice(`Added ${saved}${rejected ? `, ${rejected} not a posting` : ''}.`);
      setUrls('');
    }
  }

  async function promote(post: JobPostView, contactId: string): Promise<void> {
    const target = post.campaignId ?? campaignId;
    if (!target) {
      setError('Pick a campaign above first.');
      return;
    }
    const result = await call(contactId, 'POST', `/${post.id}/contacts/${contactId}/promote`, {
      campaignId: target,
    });
    if (result) {
      setNotice(
        result.email === true
          ? 'Added to the campaign with the address their company published. Nothing sends until you approve.'
          : 'Added to the campaign; looking for their email. Nothing sends until you approve.',
      );
    }
  }

  const posts = initial.jobPosts;

  return (
    <div className="flex flex-col gap-4">
      <section className="border-border rounded-2xl border p-4">
        {initial.searchEnabled ? (
          <form onSubmit={search} className="flex flex-wrap items-end gap-2">
            <label className="min-w-0 flex-1 text-sm font-medium">
              Search the job boards
              <input
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="senior software engineer (remote)"
                className="border-border mt-1 block w-full rounded-xl border p-2 text-sm"
              />
            </label>
            <button
              type="submit"
              disabled={busy !== undefined || keyword.trim().length < 2}
              className="bg-accent rounded-xl px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              {busy === 'search' ? 'Searching…' : 'Search'}
            </button>
          </form>
        ) : (
          <p className="text-ink-muted text-sm">
            Keyword search needs a ValueSERP key on this deployment. Paste posting URLs below.
          </p>
        )}

        <form onSubmit={add} className="mt-3 flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1 text-sm font-medium">
            Or paste posting URLs
            <textarea
              value={urls}
              onChange={(event) => setUrls(event.target.value)}
              rows={2}
              placeholder="https://apply.workable.com/raydar/j/C39C58F585/"
              className="border-border mt-1 block w-full rounded-xl border p-2 font-mono text-xs"
            />
          </label>
          <button
            type="submit"
            disabled={busy !== undefined || !urls.trim()}
            className="border-border rounded-xl border px-4 py-2 text-sm font-medium disabled:opacity-40"
          >
            {busy === 'add' ? 'Adding…' : 'Add'}
          </button>
        </form>

        <label className="text-ink-muted mt-3 block text-xs">
          Campaign for people you add
          <select
            value={campaignId}
            onChange={(event) => setCampaignId(event.target.value)}
            className="border-border ml-2 rounded-xl border p-1 text-xs"
          >
            <option value="">none (just find them)</option>
            {campaigns.map((campaign) => (
              <option key={campaign.id} value={campaign.id}>
                {campaign.name}
              </option>
            ))}
          </select>
        </label>

        {error ? <p className="text-hot mt-3 text-sm">{error}</p> : null}
        {notice ? <p className="text-ink-muted mt-3 text-sm">{notice}</p> : null}
      </section>

      {posts.length === 0 ? (
        <p className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
          No postings yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {posts.map((post) => {
            const best = post.contacts[0];
            const expanded = open === post.id;
            return (
              <li key={post.id} className="border-border rounded-2xl border p-3">
                <button
                  type="button"
                  onClick={() => setOpen(expanded ? undefined : post.id)}
                  className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 text-left"
                >
                  <span className="font-medium">{post.company ?? 'Reading…'}</span>
                  <span className="text-sm">{post.title ?? post.url}</span>
                  {post.agency ? (
                    <span className="text-ink-muted text-xs">recruiting agency</span>
                  ) : null}
                  <span className="text-ink-muted ml-auto text-xs">
                    {post.status.replace('_', ' ')}
                  </span>
                  <span className="text-ink-muted w-full text-xs">
                    {best
                      ? `${best.name}, ${best.role.replace('_', ' ')}${best.email ? ` · ${best.email}` : ''}`
                      : (post.lastError ?? 'nobody found yet')}
                  </span>
                </button>

                {expanded ? (
                  <div className="mt-3 flex flex-col gap-3 text-sm">
                    <p className="text-ink-muted text-xs">
                      <a href={post.url} target="_blank" rel="noreferrer" className="underline">
                        posting
                      </a>
                      {post.companyDomain ? (
                        <>
                          {' · '}
                          <a
                            href={`https://${post.companyDomain}`}
                            target="_blank"
                            rel="noreferrer"
                            className="underline"
                          >
                            {post.companyDomain}
                          </a>
                        </>
                      ) : null}
                      {[post.location, post.remote ? 'remote' : '', post.salary]
                        .filter(Boolean)
                        .map((part) => ` · ${part}`)}
                      {post.publishedEmails.length > 0
                        ? ` · published: ${post.publishedEmails.join(', ')}`
                        : ''}
                    </p>

                    {post.contacts.length === 0 ? (
                      <p className="text-ink-muted text-xs">Nobody found yet.</p>
                    ) : (
                      <ul className="flex flex-col gap-2">
                        {post.contacts.map((contact) => (
                          <li key={contact.id} className="flex flex-wrap items-start gap-2">
                            <div className="min-w-0 flex-1">
                              <a
                                href={contact.profileUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="font-medium underline"
                              >
                                {contact.name}
                              </a>
                              <span className="text-ink-muted ml-2 text-xs">
                                {contact.role.replace('_', ' ')}
                                {contact.email ? ` · ${contact.email}` : ''}
                                {contact.onCompanySite ? ' · named on their site' : ''}
                              </span>
                              <p className="text-ink-muted text-xs">
                                “{[contact.headline, contact.snippet].filter(Boolean).join(' · ')}”
                              </p>
                            </div>
                            {contact.personId ? (
                              <span className="text-ink-muted text-xs">in campaign</span>
                            ) : (
                              <button
                                type="button"
                                disabled={busy !== undefined}
                                onClick={() => void promote(post, contact.id)}
                                className="border-border rounded-xl border px-3 py-1 text-xs font-medium disabled:opacity-40"
                              >
                                {busy === contact.id ? 'Adding…' : 'Add to campaign'}
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}

                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={busy !== undefined}
                        onClick={() =>
                          void call(`resolve:${post.id}`, 'POST', `/${post.id}/resolve`)
                        }
                        className="bg-accent rounded-xl px-3 py-1 text-xs font-medium text-white disabled:opacity-40"
                      >
                        {busy === `resolve:${post.id}` ? 'Searching…' : 'Find people'}
                      </button>
                      <select
                        value={post.status}
                        disabled={busy !== undefined}
                        onChange={(event) =>
                          void call(`status:${post.id}`, 'PATCH', `/${post.id}`, {
                            status: event.target.value,
                          })
                        }
                        className="border-border rounded-xl border p-1 text-xs"
                      >
                        {initial.statuses.map((status) => (
                          <option key={status} value={status}>
                            {status.replace('_', ' ')}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={busy !== undefined}
                        onClick={() => {
                          if (window.confirm('Remove this posting from the list?')) {
                            void call(`delete:${post.id}`, 'DELETE', `/${post.id}`);
                          }
                        }}
                        className="text-hot ml-auto text-xs underline disabled:opacity-40"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

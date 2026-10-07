'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { BuyerLeadView, BuyerLeadsView, LeadMonitorView } from '../lib/api';
import type { ProductSummaryView } from '../lib/types';

const SOURCE_NAMES: Record<string, string> = {
  reddit: 'Reddit',
  hackernews: 'Hacker News',
  bluesky: 'Bluesky',
  web: 'Web (Google)',
  website: 'Web',
};

const list = (value: string) =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

function intentBadge(intent: number): { label: string; className: string } {
  if (intent >= 80)
    return { label: `High buyer intent ${intent}`, className: 'bg-green-100 text-green-800' };
  if (intent >= 60)
    return { label: `Buyer intent ${intent}`, className: 'bg-amber-100 text-amber-800' };
  return { label: `Intent ${intent}`, className: 'bg-border/60 text-ink-muted' };
}

/**
 * Monitors and the leads they found.
 *
 * Every write goes through `/api/v1/buyer-leads` and refreshes the page. Draft
 * AI reply writes a reply into the card; Copy and open puts it on the
 * clipboard and opens the thread, because the human posts it, never the app.
 */
export function BuyerLeadsBoard({
  initial,
  products,
  status,
  focus,
}: {
  initial: BuyerLeadsView;
  products: ProductSummaryView[];
  status: string;
  focus?: string | undefined;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(initial.monitors.length === 0);
  const [editing, setEditing] = useState<string | undefined>();

  useEffect(() => {
    if (focus) document.getElementById(`lead-${focus}`)?.scrollIntoView({ block: 'center' });
  }, [focus]);

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
      const response = await fetch(`/api/v1/buyer-leads${path}`, {
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

  async function scan(monitor: LeadMonitorView) {
    const res = await call(`scan:${monitor.id}`, 'POST', `/monitors/${monitor.id}/scan`, {});
    const r = res?.result as
      | {
          read: number;
          stored: number;
          leads: number;
          failures: { source: string; reason: string }[];
        }
      | undefined;
    if (r)
      setNotice(
        `${monitor.name}: read ${r.read} posts, ${r.stored} new, ${r.leads} lead${r.leads === 1 ? '' : 's'}.` +
          (r.failures.length
            ? ` Could not read: ${r.failures.map((f) => `${f.source} (${f.reason})`).join(', ')}.`
            : ''),
      );
  }

  async function draft(lead: BuyerLeadView) {
    const res = await call(`draft:${lead.id}`, 'POST', `/${lead.id}/draft`);
    const text = (res?.lead as BuyerLeadView | undefined)?.replyDraft;
    if (text) setDrafts((prev) => ({ ...prev, [lead.id]: text }));
  }

  async function copyAndOpen(lead: BuyerLeadView) {
    const text = drafts[lead.id] ?? lead.replyDraft ?? '';
    if (drafts[lead.id] !== undefined && drafts[lead.id] !== lead.replyDraft) {
      await call(`save:${lead.id}`, 'PATCH', `/${lead.id}`, { replyDraft: text });
    }
    try {
      await navigator.clipboard.writeText(text);
      setNotice('Reply copied. Paste it into the thread, then mark the lead replied.');
    } catch {
      setNotice('Copy the reply from the box, paste it into the thread, then mark it replied.');
    }
    window.open(lead.url, '_blank', 'noopener');
  }

  async function saveMonitor(form: HTMLFormElement, monitor?: LeadMonitorView) {
    const data = new FormData(form);
    const get = (k: string) => String(data.get(k) ?? '').trim();
    const sources = ['reddit', 'hackernews', 'bluesky', 'web'].filter((s) =>
      data.get(`source-${s}`),
    );
    const body: Record<string, unknown> = {
      ...(get('name') ? { name: get('name') } : {}),
      ...(get('url') ? { url: get('url') } : monitor ? { url: null } : {}),
      ...(get('keywords') || monitor ? { keywords: list(get('keywords')) } : {}),
      ...(get('subreddits') || monitor ? { subreddits: list(get('subreddits')) } : {}),
      ...(get('exclude') || monitor ? { exclude: list(get('exclude')) } : {}),
      sources,
      minIntent: Number(get('minIntent') || 60),
      everyMinutes: Number(get('everyMinutes') || 360),
      ...(monitor
        ? { enabled: Boolean(data.get('enabled')), digest: Boolean(data.get('digest')) }
        : {}),
      ...(!monitor && get('offeringId') ? { offeringId: get('offeringId') } : {}),
    };
    const res = monitor
      ? await call(`save:${monitor.id}`, 'PATCH', `/monitors/${monitor.id}`, body)
      : await call('create', 'POST', '/monitors', body);
    if (res) {
      setAdding(false);
      setEditing(undefined);
      if (!monitor) {
        const created = res.monitor as LeadMonitorView;
        setNotice(
          `Watching for ${created.name}: ${created.keywords.length} keywords, ${created.subreddits.length} subreddits. Scan now to see leads today.`,
        );
      }
    }
  }

  const monitorForm = (monitor?: LeadMonitorView) => (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void saveMonitor(e.currentTarget, monitor);
      }}
      className="border-border bg-surface space-y-3 rounded-2xl border p-4 text-sm"
    >
      {!monitor && products.length ? (
        <label className="block">
          <span className="text-ink-muted">For one of your products (optional)</span>
          <select name="offeringId" className="border-border mt-1 w-full rounded-lg border p-2">
            <option value="">None: describe the brand below</option>
            {products.map((p) => (
              <option key={p.offeringId} value={p.offeringId}>
                {p.name}
                {p.url ? ` (${p.url})` : ''}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-ink-muted">Brand</span>
          <input
            name="name"
            defaultValue={monitor?.name}
            placeholder="ThreatCrush"
            className="border-border mt-1 w-full rounded-lg border p-2"
          />
        </label>
        <label className="block">
          <span className="text-ink-muted">Website</span>
          <input
            name="url"
            defaultValue={monitor?.url}
            placeholder="https://threatcrush.com"
            className="border-border mt-1 w-full rounded-lg border p-2"
          />
        </label>
      </div>
      <label className="block">
        <span className="text-ink-muted">
          Keywords, comma separated{monitor ? '' : ' (left empty, they are suggested for you)'}
        </span>
        <input
          name="keywords"
          defaultValue={monitor?.keywords.join(', ')}
          placeholder="siem, intrusion detection, crowdsec alternative"
          className="border-border mt-1 w-full rounded-lg border p-2"
        />
      </label>
      <label className="block">
        <span className="text-ink-muted">Subreddits{monitor ? '' : ' (suggested when empty)'}</span>
        <input
          name="subreddits"
          defaultValue={monitor?.subreddits.join(', ')}
          placeholder="sysadmin, selfhosted, devsecops"
          className="border-border mt-1 w-full rounded-lg border p-2"
        />
      </label>
      <label className="block">
        <span className="text-ink-muted">Skip posts containing</span>
        <input
          name="exclude"
          defaultValue={monitor?.exclude.join(', ')}
          placeholder="hiring, giveaway"
          className="border-border mt-1 w-full rounded-lg border p-2"
        />
      </label>
      <div className="flex flex-wrap gap-4">
        {['reddit', 'hackernews', 'bluesky', 'web'].map((s) => (
          <label key={s} className="flex items-center gap-2">
            <input
              type="checkbox"
              name={`source-${s}`}
              defaultChecked={monitor ? monitor.sources.includes(s) : true}
            />
            {SOURCE_NAMES[s]}
          </label>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-ink-muted">Minimum intent (0-100)</span>
          <input
            name="minIntent"
            type="number"
            min={0}
            max={100}
            defaultValue={monitor?.minIntent ?? 60}
            className="border-border mt-1 w-full rounded-lg border p-2"
          />
        </label>
        <label className="block">
          <span className="text-ink-muted">Scan every (minutes, 60 or more)</span>
          <input
            name="everyMinutes"
            type="number"
            min={60}
            defaultValue={monitor?.everyMinutes ?? 360}
            className="border-border mt-1 w-full rounded-lg border p-2"
          />
        </label>
      </div>
      {monitor ? (
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2">
            <input type="checkbox" name="enabled" defaultChecked={monitor.enabled} /> Scanning on
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="digest" defaultChecked={monitor.digest} /> Daily digest
            email
          </label>
        </div>
      ) : null}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy === 'create' || busy === `save:${monitor?.id}`}
          className="bg-accent rounded-xl px-4 py-2 font-medium text-white disabled:opacity-60"
        >
          {monitor ? 'Save' : busy === 'create' ? 'Setting up…' : 'Start watching'}
        </button>
        <button
          type="button"
          onClick={() => (monitor ? setEditing(undefined) : setAdding(false))}
          className="border-border rounded-xl border px-4 py-2"
        >
          Cancel
        </button>
        {monitor ? (
          <button
            type="button"
            onClick={() => {
              if (confirm(`Stop watching ${monitor.name} and delete its leads?`))
                void call(`rm:${monitor.id}`, 'DELETE', `/monitors/${monitor.id}`);
            }}
            className="ml-auto text-xs text-red-700 underline"
          >
            Delete monitor
          </button>
        ) : null}
      </div>
    </form>
  );

  return (
    <div className="space-y-4">
      <section className="space-y-3">
        {initial.monitors.map((m) =>
          editing === m.id ? (
            <div key={m.id}>{monitorForm(m)}</div>
          ) : (
            <div
              key={m.id}
              className="border-border bg-surface flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-4"
            >
              <div className="min-w-0 flex-1 text-sm">
                <div className="font-medium">
                  {m.name}
                  {m.enabled ? '' : ' (paused)'}
                </div>
                <div className="text-ink-muted">
                  {m.keywords.slice(0, 6).join(', ')}
                  {m.keywords.length > 6 ? ` +${m.keywords.length - 6}` : ''}
                </div>
                <div className="text-ink-muted">
                  {m.sources.map((s) => SOURCE_NAMES[s] ?? s).join(', ')}
                  {m.subreddits.length ? ` · ${m.subreddits.length} subreddits` : ''} · every{' '}
                  {m.everyMinutes >= 60
                    ? `${Math.round(m.everyMinutes / 60)}h`
                    : `${m.everyMinutes}m`}{' '}
                  ·{' '}
                  {m.lastScannedAt
                    ? `last scan ${new Date(m.lastScannedAt).toLocaleString()}`
                    : 'not scanned yet'}
                  {initial.judgeEnabled ? '' : ' · wording only (no model)'}
                </div>
                {m.lastError ? <div className="text-red-700">{m.lastError}</div> : null}
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setEditing(m.id)}
                  className="border-border rounded-xl border px-3 py-1.5 text-sm"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => scan(m)}
                  disabled={busy === `scan:${m.id}`}
                  className="bg-accent rounded-xl px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
                >
                  {busy === `scan:${m.id}` ? 'Scanning… (a minute or two)' : 'Scan now'}
                </button>
              </div>
            </div>
          ),
        )}
        {adding ? (
          monitorForm()
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="border-border text-ink-muted w-full rounded-2xl border border-dashed p-3 text-sm"
          >
            + Watch another brand
          </button>
        )}
      </section>

      {error ? (
        <p className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="border-border bg-surface rounded-xl border p-3 text-sm">{notice}</p>
      ) : null}

      <nav className="flex gap-2 text-sm">
        {['new', 'replied', 'dismissed'].map((s) => (
          <Link
            key={s}
            href={s === 'new' ? '/buyer-leads' : `/buyer-leads?status=${s}`}
            className={`rounded-full px-3 py-1 ${status === s ? 'bg-accent/15 text-accent' : 'text-ink-muted'}`}
          >
            {s === 'new' ? 'New' : s === 'replied' ? 'Replied' : 'Dismissed'}
          </Link>
        ))}
      </nav>

      {initial.leads.length === 0 ? (
        <p className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
          {initial.monitors.length === 0
            ? 'Add a brand above. Leads appear here and in a daily email.'
            : status === 'new'
              ? 'No leads over the intent floor yet. Scans run on their own; Scan now runs one today.'
              : `Nothing ${status} yet.`}
        </p>
      ) : (
        <ul className="space-y-3">
          {initial.leads.map((lead) => {
            const badge = intentBadge(lead.intent);
            const draftText = drafts[lead.id] ?? lead.replyDraft;
            return (
              <li
                key={lead.id}
                id={`lead-${lead.id}`}
                className={`border-border bg-surface rounded-2xl border p-4 ${focus === lead.id ? 'ring-accent ring-2' : ''}`}
              >
                <div className="text-ink-muted mb-1 flex flex-wrap items-center gap-2 text-xs tracking-wide uppercase">
                  <span>{SOURCE_NAMES[lead.source] ?? lead.source}</span>
                  {lead.container ? <span>· {lead.container}</span> : null}
                  <span className={`rounded-full px-2 py-0.5 normal-case ${badge.className}`}>
                    {badge.label}
                    {lead.judged ? '' : ' (wording)'}
                  </span>
                  <span className="normal-case">
                    · {lead.monitorName} · {new Date(lead.postedAt).toLocaleDateString()}
                  </span>
                </div>
                {lead.title ? (
                  <a
                    href={lead.url}
                    target="_blank"
                    rel="noopener"
                    className="block font-medium hover:underline"
                  >
                    {lead.title}
                  </a>
                ) : null}
                <blockquote className="border-border text-ink my-2 border-l-4 pl-3 text-sm">
                  “{lead.excerpt.length > 400 ? `${lead.excerpt.slice(0, 399)}…` : lead.excerpt}”
                </blockquote>
                {lead.reason ? <p className="text-ink-muted text-sm">{lead.reason}</p> : null}
                <div className="text-ink-muted mt-1 text-xs">
                  by{' '}
                  {lead.authorUrl ? (
                    <a href={lead.authorUrl} target="_blank" rel="noopener" className="underline">
                      {lead.author}
                    </a>
                  ) : (
                    lead.author
                  )}
                  {lead.matchedTerm ? ` · matched “${lead.matchedTerm}”` : ''}
                </div>

                {draftText !== undefined ? (
                  <textarea
                    value={draftText}
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [lead.id]: e.target.value }))}
                    rows={5}
                    className="border-border mt-3 w-full rounded-lg border p-2 text-sm"
                  />
                ) : null}

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => draft(lead)}
                    disabled={!initial.judgeEnabled || busy === `draft:${lead.id}`}
                    title={initial.judgeEnabled ? '' : 'No model is configured on this server'}
                    className="bg-accent rounded-xl px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                  >
                    {busy === `draft:${lead.id}`
                      ? 'Drafting…'
                      : draftText
                        ? 'Redraft'
                        : 'Draft AI reply'}
                  </button>
                  {draftText ? (
                    <button
                      type="button"
                      onClick={() => copyAndOpen(lead)}
                      className="border-border rounded-xl border px-3 py-1.5 text-sm font-medium"
                    >
                      Copy reply and open thread
                    </button>
                  ) : (
                    <a
                      href={lead.url}
                      target="_blank"
                      rel="noopener"
                      className="border-border rounded-xl border px-3 py-1.5 text-sm"
                    >
                      Open thread
                    </a>
                  )}
                  {lead.status !== 'replied' ? (
                    <button
                      type="button"
                      onClick={() =>
                        call(`st:${lead.id}`, 'PATCH', `/${lead.id}`, { status: 'replied' })
                      }
                      className="text-ink-muted text-xs underline"
                    >
                      Mark replied
                    </button>
                  ) : null}
                  {lead.status !== 'dismissed' ? (
                    <button
                      type="button"
                      onClick={() =>
                        call(`st:${lead.id}`, 'PATCH', `/${lead.id}`, { status: 'dismissed' })
                      }
                      className="text-ink-muted text-xs underline"
                    >
                      Dismiss
                    </button>
                  ) : null}
                  {lead.status !== 'new' ? (
                    <button
                      type="button"
                      onClick={() =>
                        call(`st:${lead.id}`, 'PATCH', `/${lead.id}`, { status: 'new' })
                      }
                      className="text-ink-muted text-xs underline"
                    >
                      Back to new
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-ink-muted text-xs">
        Replies are drafts. OutreachGraph never posts in communities for you: read the thread, edit
        the reply, and post it under your own name.
      </p>
    </div>
  );
}

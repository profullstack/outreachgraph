'use client';

import { useEffect, useState } from 'react';
import { LINK_POST_FORMATS, LINK_POST_NETWORKS, type LinkPostNetwork } from '@outreachgraph/domain';

interface SourceView {
  url: string | null;
  postNetworks: LinkPostNetwork[];
  checkedAt: string | null;
  error: string | null;
}

/**
 * The URL a campaign reads on a schedule, and the networks it drafts for.
 *
 * New feed items, or a change to the page, become drafted posts under
 * Approve → Manual posts, in this campaign's voice for its target customer.
 */
export function CampaignSource({ campaignId }: { campaignId: string }) {
  const [source, setSource] = useState<SourceView | undefined>();
  const [url, setUrl] = useState('');
  const [networks, setNetworks] = useState<LinkPostNetwork[]>(['linkedin']);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();

  useEffect(() => {
    void fetch(`/api/v1/campaigns/${encodeURIComponent(campaignId)}`, {
      credentials: 'same-origin',
    })
      .then((response) => response.json())
      .then((payload: { source?: SourceView }) => {
        if (!payload.source) return;
        setSource(payload.source);
        setUrl(payload.source.url ?? '');
        setNetworks(payload.source.postNetworks);
      })
      .catch(() => undefined);
  }, [campaignId]);

  async function save(): Promise<void> {
    setBusy(true);
    setMessage(undefined);
    try {
      const response = await fetch(`/api/v1/campaigns/${encodeURIComponent(campaignId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ sourceUrl: url, postNetworks: networks }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      setMessage(
        response.ok ? 'Saved.' : (payload.error?.message ?? `that failed (${response.status})`),
      );
    } finally {
      setBusy(false);
    }
  }

  async function checkNow(): Promise<void> {
    setBusy(true);
    setMessage(undefined);
    try {
      const response = await fetch(
        `/api/v1/campaigns/${encodeURIComponent(campaignId)}/source/check`,
        { method: 'POST', credentials: 'same-origin' },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        result?: { mode: string; newItems: number; drafted: number; error?: string };
        error?: { message?: string };
      };
      if (!response.ok || !payload.result) {
        setMessage(payload.error?.message ?? `that failed (${response.status})`);
        return;
      }
      const r = payload.result;
      setMessage(
        r.error
          ? `Could not read it: ${r.error}`
          : `Read the ${r.mode}: ${r.newItems} new, ${r.drafted} drafted into Manual posts.`,
      );
    } finally {
      setBusy(false);
    }
  }

  function toggle(network: LinkPostNetwork): void {
    setNetworks((current) =>
      current.includes(network)
        ? current.filter((n) => n !== network)
        : LINK_POST_NETWORKS.filter((n) => n === network || current.includes(n)),
    );
  }

  return (
    <section className="border-border bg-surface-raised mt-3 rounded-2xl border p-3">
      <h2 className="text-sm font-semibold">Posts from</h2>
      <p className="text-ink-muted text-xs">
        Read every 6 hours. New posts in its feed, or a change to the page, are drafted in this
        campaign&rsquo;s voice for its customers and wait under Approve → Manual posts.
      </p>
      <input
        type="url"
        inputMode="url"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        placeholder="https://yoursite.com/blog"
        aria-label="URL this campaign posts from"
        className="border-border bg-surface mt-2 w-full rounded-xl border px-3 py-2 text-sm"
      />
      <div className="mt-2 flex flex-wrap gap-1.5">
        {LINK_POST_NETWORKS.map((network) => {
          const on = networks.includes(network);
          return (
            <button
              key={network}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(network)}
              className={`rounded-full border px-2.5 py-0.5 text-xs ${
                on ? 'border-accent bg-accent text-white' : 'border-border'
              }`}
            >
              {LINK_POST_FORMATS[network].label}
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          disabled={busy || !url.trim() || networks.length === 0}
          onClick={() => void save()}
          className="bg-accent rounded-xl px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
        >
          Save
        </button>
        <button
          type="button"
          disabled={busy || !source?.url}
          onClick={() => void checkNow()}
          className="border-border rounded-xl border px-3 py-1.5 text-sm disabled:opacity-40"
        >
          Check now
        </button>
        <span className="text-ink-muted text-xs">
          {message ??
            (source?.error
              ? `Last read failed: ${source.error}`
              : source?.checkedAt
                ? `Last read ${new Date(source.checkedAt).toLocaleString()}`
                : 'Not read yet')}
        </span>
      </div>
    </section>
  );
}

'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useState } from 'react';
import type { CampaignSummaryView } from '../lib/api';

/**
 * Every campaign, and the controls each one needs.
 *
 * The product was built as though there were one campaign: intake created it,
 * the funnel showed it, and running a second market meant hoping the right one
 * was picked up. Several at once changes the first question from "how is it
 * going" to "which of these is doing anything", so each row leads with counts
 * and carries its own switches.
 *
 * Pause is separate from autopilot on purpose. Turning autopilot off stops
 * sending but leaves the campaign crawling, scoring and filling the approval
 * queue; pausing stops the work. Collapsing them into one control would remove
 * the ability to keep researching a market you are not ready to contact.
 */
export function CampaignList({ initial }: { initial: readonly CampaignSummaryView[] }) {
  const [campaigns, setCampaigns] = useState([...initial]);
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const router = useRouter();

  async function patch(id: string, body: Record<string, unknown>): Promise<void> {
    setBusy(id);
    setError(undefined);

    try {
      const response = await fetch(`/api/v1/campaigns/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setError(payload?.error?.message ?? `that failed (${response.status})`);
        return;
      }

      setCampaigns((current) =>
        current.map((campaign) =>
          campaign.id === id
            ? {
                ...campaign,
                ...(typeof body.autopilot === 'boolean'
                  ? {
                      approval_mode: body.autopilot ? 'trusted_automation' : 'draft_and_approve',
                    }
                  : {}),
                ...(typeof body.status === 'string' ? { status: body.status } : {}),
              }
            : campaign,
        ),
      );

      // The funnel and Today both read campaign state, so they are refreshed
      // rather than left showing the previous answer.
      router.refresh();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(undefined);
    }
  }

  if (campaigns.length === 0) {
    return (
      <p className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
        No campaigns yet. Enter a website or describe a market above to start one.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <p role="alert" className="text-hot text-sm">
          {error}
        </p>
      ) : null}

      {campaigns.map((campaign) => {
        const autopilot = campaign.approval_mode === 'trusted_automation';
        const archived = campaign.status === 'archived';
        const working = campaign.jobs_pending > 0;

        return (
          <article
            key={campaign.id}
            className={`border-border bg-surface-raised rounded-2xl border p-4 ${
              archived ? 'opacity-60' : ''
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="truncate text-sm font-semibold">{campaign.name}</h2>
                <p className="text-ink-muted mt-0.5 truncate text-xs">
                  {campaign.seed_kind === 'url' ? 'Site' : 'Market'}
                  {campaign.seed_value ? ` · ${campaign.seed_value}` : ''}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                {working ? (
                  <span className="border-accent text-accent rounded-full border px-2 py-0.5 text-[11px]">
                    {campaign.jobs_pending} running
                  </span>
                ) : null}
                <span
                  className={`rounded-full border px-2 py-0.5 text-[11px] ${
                    archived
                      ? 'border-border text-ink-muted'
                      : campaign.status === 'paused'
                        ? 'border-border text-ink-muted'
                        : 'border-accent text-accent'
                  }`}
                >
                  {archived ? 'Archived' : campaign.status === 'paused' ? 'Paused' : 'Active'}
                </span>
              </div>
            </div>

            <dl className="mt-3 grid grid-cols-4 gap-2 text-center">
              <Count label="Leads" value={campaign.people} />
              <Count label="Contacted" value={campaign.contacted} />
              <Count label="Replied" value={campaign.replied} />
              <Count label="To approve" value={campaign.awaiting_approval} />
            </dl>

            {!archived ? (
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    checked={autopilot}
                    disabled={busy === campaign.id}
                    onChange={(e) => patch(campaign.id, { autopilot: e.target.checked })}
                  />
                  Autopilot
                </label>

                <button
                  type="button"
                  disabled={busy === campaign.id}
                  onClick={() =>
                    patch(campaign.id, {
                      status: campaign.status === 'paused' ? 'active' : 'paused',
                    })
                  }
                  className="border-border rounded-xl border px-3 py-1.5 text-[13px] disabled:opacity-40"
                >
                  {campaign.status === 'paused' ? 'Resume' : 'Pause'}
                </button>

                <Link
                  href={`/funnel?campaignId=${encodeURIComponent(campaign.id)}`}
                  className="text-accent px-1 py-1.5 text-[13px] underline"
                >
                  Funnel
                </Link>

                <button
                  type="button"
                  disabled={busy === campaign.id}
                  onClick={() => {
                    if (confirm(`Archive “${campaign.name}”? Its queued work is cancelled.`)) {
                      void patch(campaign.id, { status: 'archived' });
                    }
                  }}
                  className="text-ink-muted ml-auto px-1 py-1.5 text-[13px] underline disabled:opacity-40"
                >
                  Archive
                </button>
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dd className="text-base font-semibold tabular-nums">{value}</dd>
      <dt className="text-ink-muted text-[11px]">{label}</dt>
    </div>
  );
}

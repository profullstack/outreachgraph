'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * What a campaign's leads are missing, and a button that fills it in.
 *
 * A worker sweep already does this a little at a time; the button is for the
 * moment after an import, when the owner wants titles before the first drafts
 * are written. Searches take 10-45 s each, so the run continues in the
 * background and this polls for the outcome.
 */

interface Status {
  readonly leads: number;
  readonly missing_name: number;
  readonly missing_title: number;
  readonly missing_linkedin: number;
  readonly providers: { readonly valueserp: boolean; readonly pdl: boolean };
  readonly today: { readonly searches: number; readonly searches_cap: number };
  readonly paused?: { readonly valueserp?: string; readonly pdl?: string };
  readonly running: boolean;
  readonly last_run?: {
    readonly names?: number;
    readonly titles?: number;
    readonly profiles?: number;
    readonly companies?: number;
    readonly searches?: number;
    readonly cached?: number;
    readonly stopped?: string;
    readonly error?: string;
  };
}

export function LeadEnrichment({ campaignId }: { campaignId: string }) {
  const [status, setStatus] = useState<Status | undefined>();
  const [error, setError] = useState<string | undefined>();
  const url = `/api/v1/autogtm/campaigns/${encodeURIComponent(campaignId)}`;

  const load = useCallback(async () => {
    const response = await fetch(`${url}/enrichment`, { credentials: 'same-origin' });
    if (response.ok) setStatus((await response.json()) as Status);
  }, [url]);

  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  useEffect(() => {
    if (!status?.running) return;
    const timer = setInterval(() => void load().catch(() => undefined), 5_000);
    return () => clearInterval(timer);
  }, [status?.running, load]);

  async function start(): Promise<void> {
    setError(undefined);
    const response = await fetch(`${url}/enrich`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({}),
    });
    if (!response.ok) {
      setError(`Could not start (${response.status}).`);
      return;
    }
    await load();
  }

  if (!status || status.leads === 0) return null;
  const missing = status.missing_title + status.missing_linkedin + status.missing_name;
  const last = status.last_run;

  return (
    <div className="border-border bg-surface-raised mb-3 rounded-xl border p-3 text-sm">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1">
          {missing === 0 ? (
            'Every lead has a name, a title and a LinkedIn.'
          ) : (
            <>
              Missing: <strong>{status.missing_title.toLocaleString()}</strong> titles,{' '}
              <strong>{status.missing_linkedin.toLocaleString()}</strong> LinkedIn,{' '}
              <strong>{status.missing_name.toLocaleString()}</strong> names.
            </>
          )}
        </p>
        {missing > 0 ? (
          <button
            type="button"
            disabled={status.running}
            onClick={() => void start()}
            className="border-border shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium disabled:opacity-40"
          >
            {status.running ? 'Looking them up…' : 'Find them'}
          </button>
        ) : null}
      </div>
      <p className="text-ink-muted mt-1 text-xs">
        Names from addresses (free)
        {status.providers.pdl ? ', People Data Labs' : ''}
        {status.providers.valueserp
          ? `, then a Google search of LinkedIn (${status.today.searches} of ${status.today.searches_cap} searches used today)`
          : '. LinkedIn search is not configured on this deployment'}
        . Only blanks are filled.
        {status.paused?.valueserp
          ? ` Search is out of credits until ${status.paused.valueserp}.`
          : ''}
      </p>
      {last && !status.running ? (
        <p className="text-ink-muted mt-1 text-xs">
          {last.error
            ? `Last run failed: ${last.error}`
            : `Last run: +${last.names ?? 0} names, +${last.titles ?? 0} titles, +${last.profiles ?? 0} profiles, +${last.companies ?? 0} company pages from ${last.searches ?? 0} searches (${last.cached ?? 0} cached)${last.stopped ? `; stopped: ${last.stopped}` : ''}.`}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-hot mt-1 text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}

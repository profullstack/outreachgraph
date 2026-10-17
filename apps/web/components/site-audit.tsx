'use client';

import { useState } from 'react';
import type { ProspectSiteAudit } from '../lib/types';

/**
 * Their company homepage, as seo.rank sees it: score, grade and the fixes
 * that matter most. An outreach angle with its evidence on screen, and the
 * same one the composer is offered. "Audit again" queues a fresh audit; the
 * worker runs it within a minute or so.
 */
export function SiteAudit({ personId, data }: { personId: string; data: ProspectSiteAudit }) {
  const [note, setNote] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const { company, audit, auditable } = data;
  if (!auditable) return null;

  async function again(): Promise<void> {
    setBusy(true);
    setNote(undefined);
    try {
      const response = await fetch(`/api/v1/people/${encodeURIComponent(personId)}/site-audit`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      setNote(response.ok ? 'Queued. Refresh in a minute.' : `that failed (${response.status})`);
    } catch {
      setNote('could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  const checked = audit?.checkedAt ? new Date(audit.checkedAt).toLocaleDateString() : null;

  return (
    <section className="mt-6">
      <h2 className="text-ink-muted text-[11px] font-semibold tracking-wide uppercase">
        Homepage audit
      </h2>
      <div className="border-border bg-surface-raised mt-2 rounded-xl border p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{company.domain}</div>
            <div className="text-ink-muted text-xs">
              {audit?.status === 'ok' && checked
                ? `seo.rank, checked ${checked}`
                : audit?.status === 'failed'
                  ? `could not be audited: ${audit.error ?? 'the site refused'}`
                  : audit
                    ? 'audit retrying'
                    : 'not audited yet; queued'}
            </div>
          </div>
          {audit?.status === 'ok' && audit.score != null ? (
            <span className="shrink-0 text-lg font-semibold tabular-nums">
              {audit.score}
              <span className="text-ink-muted text-xs"> /100 · {audit.grade}</span>
            </span>
          ) : null}
        </div>
        {audit?.status === 'ok' && audit.fixes.length ? (
          <ol className="mt-2 list-decimal pl-5 text-sm">
            {audit.fixes.slice(0, 3).map((fix) => (
              <li key={fix.id} className="mt-1">
                <span className="font-medium">{fix.label}</span>
                <span className="text-ink-muted"> ({fix.priority})</span>: {fix.fix}
              </li>
            ))}
          </ol>
        ) : null}
        <div className="text-ink-muted mt-2 flex items-center gap-3 text-xs">
          {audit ? (
            <a
              className="text-accent underline"
              href={audit.reportUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              full report
            </a>
          ) : null}
          <button type="button" className="text-accent underline" disabled={busy} onClick={again}>
            {busy ? 'queueing…' : 'audit again'}
          </button>
          {note ? <span>{note}</span> : null}
        </div>
      </div>
    </section>
  );
}

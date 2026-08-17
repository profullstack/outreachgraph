'use client';

import { useEffect, useRef, useState } from 'react';
import { describeKinds } from '../lib/activity';
import type { WorkflowEventView, WorkflowStatusView } from '../lib/api';

/**
 * What the workflow is doing, right now.
 *
 * The complaint this answers is that there was no way to tell a campaign that
 * was working from one that had quietly stopped. So this shows two things at
 * once: the aggregate state (how much work is queued, whether anything is
 * sending, whether the mail server is verified) and the running commentary
 * behind it.
 *
 * It connects with `EventSource` rather than polling, which matters mostly for
 * reconnection: the browser handles it, and because our event ids are the
 * database cursor, a reconnect resumes exactly where it left off instead of
 * replaying or skipping. The server-rendered snapshot is passed in so the panel
 * is never blank while the stream opens.
 */
export function LiveStatus({
  initialStatus,
  initialEvents,
  campaignId,
  limit = 40,
}: {
  initialStatus?: WorkflowStatusView;
  initialEvents?: readonly WorkflowEventView[];
  campaignId?: string;
  limit?: number;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [events, setEvents] = useState<WorkflowEventView[]>([...(initialEvents ?? [])]);
  const [connected, setConnected] = useState(false);
  const seen = useRef(new Set<number>((initialEvents ?? []).map((event) => event.seq)));

  useEffect(() => {
    const query = new URLSearchParams();
    if (campaignId) query.set('campaignId', campaignId);

    // Resume from the newest event already rendered, so opening the page does
    // not repeat the history the server just sent.
    const newest = Math.max(0, ...[...seen.current]);
    if (newest > 0) query.set('since', String(newest));

    const source = new EventSource(`/api/v1/events?${query.toString()}`);

    source.addEventListener('open', () => setConnected(true));

    source.addEventListener('status', (event) => {
      try {
        setStatus(JSON.parse((event as MessageEvent).data) as WorkflowStatusView);
        setConnected(true);
      } catch {
        // A malformed frame is not worth tearing the stream down for.
      }
    });

    source.addEventListener('workflow', (event) => {
      try {
        const parsed = JSON.parse((event as MessageEvent).data) as WorkflowEventView;
        if (seen.current.has(parsed.seq)) return;
        seen.current.add(parsed.seq);
        setEvents((current) => [parsed, ...current].slice(0, limit));
      } catch {
        // As above.
      }
    });

    // `EventSource` retries on its own, so this only reflects the indicator;
    // closing here would defeat the reconnection we want.
    source.addEventListener('error', () => setConnected(false));

    return () => source.close();
  }, [campaignId, limit]);

  return (
    <section className="border-border bg-surface-raised rounded-2xl border p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">Right now</h2>
        <span className="text-ink-muted flex items-center gap-1.5 text-xs">
          <span
            aria-hidden
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              status?.busy ? 'bg-accent animate-pulse' : connected ? 'bg-accent' : 'bg-ink-muted'
            }`}
          />
          {status?.busy ? 'Working' : connected ? 'Idle' : 'Reconnecting'}
        </span>
      </div>

      {status ? <StatusGrid status={status} /> : null}

      {status && !status.sending.verified ? (
        <p className="text-ink-muted mt-3 text-xs">
          {status.sending.configured
            ? 'Your mail server is not verified yet, so outreach still goes out from our domain.'
            : 'No mail server connected — outreach goes out from our domain.'}
        </p>
      ) : null}

      <ol className="mt-4 flex flex-col gap-2">
        {events.length === 0 ? (
          <li className="text-ink-muted text-sm">
            Nothing has happened yet. Start a campaign and this fills in as it runs.
          </li>
        ) : (
          events.map((event) => (
            <li key={event.seq} className="flex items-start gap-2 text-[13px] leading-relaxed">
              <PhaseDot level={event.level} />
              <span className="min-w-0 flex-1">
                <span className={event.level === 'error' ? 'text-hot' : ''}>{event.message}</span>
                <span className="text-ink-muted ml-1.5 text-[11px] whitespace-nowrap tabular-nums">
                  {clock(event.occurredAt)}
                </span>
              </span>
            </li>
          ))
        )}
      </ol>
    </section>
  );
}

function StatusGrid({ status }: { status: WorkflowStatusView }) {
  const queued = status.queue.pending + status.queue.running;

  return (
    <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Stat
        label="In the queue"
        value={queued}
        // Which kind of work is outstanding turns "12 jobs" into something
        // actionable — reading sites and expanding keywords fail for entirely
        // different reasons.
        hint={describeKinds(status.queue.byKind)}
      />
      <Stat label="Done today" value={status.queue.doneToday} />
      <Stat
        label="Sent today"
        value={status.sending.sentToday}
        hint={`cap ${status.sending.dailyCap}`}
      />
      <Stat
        label="Campaigns"
        value={status.activeCampaigns}
        hint={
          status.autopilotCampaigns > 0
            ? `${status.autopilotCampaigns} on autopilot`
            : 'none automatic'
        }
      />
    </dl>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div>
      <dt className="text-ink-muted text-xs">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
      {hint ? <dd className="text-ink-muted text-[11px]">{hint}</dd> : null}
    </div>
  );
}

function PhaseDot({ level }: { level: string }) {
  const colour =
    level === 'error'
      ? 'bg-hot'
      : level === 'warn'
        ? 'bg-ink-muted'
        : level === 'success'
          ? 'bg-accent'
          : 'bg-border';

  return <span aria-hidden className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${colour}`} />;
}

/**
 * A wall-clock time rather than "3 minutes ago".
 *
 * Relative times are better for a feed that is read once, and worse for one
 * that is watched — a list where every row silently says "just now" gives no
 * sense of pace.
 */
function clock(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

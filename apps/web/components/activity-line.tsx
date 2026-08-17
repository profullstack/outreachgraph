'use client';

import { useEffect, useState } from 'react';
import { describeActivity, describeSending } from '../lib/activity';
import type { WorkflowStatusView } from '../lib/api';

/**
 * "Is it doing anything right now", in one line, on every page.
 *
 * The full panel on Today answers this properly, with the running commentary
 * behind it. But the question does not only get asked on Today — it gets asked
 * hardest on the pages where nothing seems to be happening, which are exactly
 * the ones that used to say nothing at all. Someone staring at an empty
 * prospect list cannot tell a crawl in progress from a crawl that died.
 *
 * This subscribes to `status` frames only and ignores the event tail. The
 * server sends one on connect and then every fifth tick, so the line is at most
 * ten seconds stale while costing the stream nothing extra. The server-rendered
 * snapshot is passed in so it is never blank, and reads correctly with
 * JavaScript disabled.
 */
export function ActivityLine({
  initialStatus,
  /**
   * What an idle queue means on this workspace, when the status block cannot
   * say. "Nothing queued" reads as a stall to someone who has not started a
   * campaign yet and as normal to someone who has, and the difference is not
   * visible in any of the aggregates.
   */
  idleHint,
}: {
  initialStatus?: WorkflowStatusView;
  idleHint?: string;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [live, setLive] = useState(false);

  useEffect(() => {
    // Resume past the history already on the server's cursor: this line never
    // renders the event tail, so replaying it would be pure transfer.
    const since = initialStatus?.latestSeq ?? 0;
    const source = new EventSource(`/api/v1/events?limit=1&since=${since}`);

    source.addEventListener('open', () => setLive(true));

    source.addEventListener('status', (event) => {
      try {
        setStatus(JSON.parse((event as MessageEvent).data) as WorkflowStatusView);
        setLive(true);
      } catch {
        // A malformed frame is not worth tearing the stream down for.
      }
    });

    // `EventSource` reconnects on its own; closing here would defeat it.
    source.addEventListener('error', () => setLive(false));

    return () => source.close();
    // Only the first snapshot seeds the cursor; later ones arrive on the stream.
  }, [initialStatus?.latestSeq]);

  const busy = status?.busy ?? false;
  const trailing = describeSending(status);

  // The hint only replaces the generic sentence while there is genuinely
  // nothing happening; once work is in flight the queue speaks for itself.
  const quiet = status !== undefined && !busy && status.queue.pending + status.queue.running === 0;
  const sentence = quiet && idleHint ? idleHint : describeActivity(status);

  return (
    <p className="text-ink-muted flex items-start gap-2 text-[13px] leading-relaxed">
      <span
        aria-hidden
        className={`mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
          busy ? 'bg-accent animate-pulse' : live ? 'bg-accent' : 'bg-ink-muted'
        }`}
      />
      <span className="min-w-0">
        <span className="text-ink font-medium">Right now: </span>
        {sentence}
        {trailing ? <span className="text-ink-muted"> {trailing}.</span> : null}
      </span>
    </p>
  );
}

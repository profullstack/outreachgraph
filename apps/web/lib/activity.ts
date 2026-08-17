/**
 * How to say what the workflow is doing, in one line.
 *
 * Shared between the compact line that sits on every page and the full panel on
 * Today, so the two cannot drift into describing the same queue in different
 * words. Two descriptions of one queue read as two systems, which is a worse
 * failure than either wording on its own.
 *
 * Pure functions with no server imports: this is rendered inside client
 * components that re-run it as `status` frames arrive over SSE.
 */

import type { WorkflowStatusView } from './api';

/** Job kinds in the operator's words rather than the queue's. */
const KIND_LABELS: Record<string, string> = {
  crawl_site: 'reading sites',
  discover_domains: 'finding companies',
  rescore_prospect: 'rescoring',
  process_deletion: 'deleting',
};

/**
 * Which kind of work is outstanding, not just how much.
 *
 * "12 jobs" is not actionable; reading sites and expanding keywords stall for
 * entirely different reasons, and the reader can only tell which is stuck if
 * the queue says what is in it.
 */
export function describeKinds(byKind: Record<string, number>): string | undefined {
  const parts = Object.entries(byKind)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${count} ${KIND_LABELS[kind] ?? kind.replace(/_/g, ' ')}`);

  return parts.length > 0 ? parts.join(', ') : undefined;
}

/**
 * One sentence for "is this thing doing anything at all".
 *
 * An idle queue is the ambiguous case and the one worth spending words on: it
 * means something completely different depending on whether a campaign exists
 * to feed it. "Idle" alone is exactly what made people open the container logs.
 */
export function describeActivity(status: WorkflowStatusView | undefined): string {
  if (!status) return 'Waiting for the API.';

  const queued = status.queue.pending + status.queue.running;

  if (status.busy) {
    const kinds = describeKinds(status.queue.byKind);
    return kinds ? `Working now: ${kinds}.` : `Working now, ${queued} in the queue.`;
  }

  if (queued > 0) return `${queued} queued, nothing running this second.`;
  if (status.activeCampaigns === 0) return 'Nothing running. No campaign has been started yet.';
  if (status.queue.doneToday > 0) {
    return `Nothing queued. ${status.queue.doneToday} finished today.`;
  }

  return 'Nothing queued. Waiting for the next scheduled pass.';
}

/**
 * The trailing half of the line: what has gone out, and what has broken.
 *
 * Kept separate from the sentence above because it is the part worth showing
 * in a quieter colour, and because a failure count deserves to survive even
 * when the queue itself is idle and looks healthy.
 */
export function describeSending(status: WorkflowStatusView | undefined): string | undefined {
  if (!status) return undefined;

  const parts: string[] = [];

  if (status.sending.sentToday > 0) {
    parts.push(`${status.sending.sentToday} of ${status.sending.dailyCap} sent today`);
  }
  if (status.queue.failed > 0) parts.push(`${status.queue.failed} failed`);
  if (status.sending.failedToday > 0) parts.push(`${status.sending.failedToday} failed to send`);

  return parts.length > 0 ? parts.join(' · ') : undefined;
}

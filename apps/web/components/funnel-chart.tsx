/**
 * The funnel, and the sideways view of how leads moved through it.
 *
 * Two charts, both deliberately plain. Sales dashboards tend toward donuts and
 * gauges; the questions people actually ask are "how many got to each stage"
 * and "where do they stall", and a bar whose length is the count answers both
 * without a legend.
 *
 * Server-rendered with no charting library. Every bar is a div with a width
 * percentage, which keeps the page working with JavaScript disabled, adds
 * nothing to the bundle, and — since artifacts of this app render in both
 * themes — inherits the palette rather than hard-coding colours.
 */

import Link from 'next/link';
import type { FunnelStageView, LeadTimelineView } from '../lib/api';

/** Stage order, so a timeline segment can be positioned without a lookup. */
const STAGE_ORDER = ['discovered', 'researched', 'ready', 'contacted', 'replied', 'opportunity'];

const STAGE_LABEL: Record<string, string> = {
  discovered: 'Found',
  researched: 'Researched',
  ready: 'Ready to send',
  contacted: 'Contacted',
  replied: 'Replied',
  opportunity: 'Opportunity',
  lost: 'Lost',
};

/**
 * Stage shading, light to dark down the funnel.
 *
 * Opacity on one accent rather than six hues: the stages are ordered, and six
 * unrelated colours would imply they are categories rather than a sequence.
 */
const STAGE_TONE: Record<string, string> = {
  discovered: 'bg-accent/25',
  researched: 'bg-accent/40',
  ready: 'bg-accent/55',
  contacted: 'bg-accent/70',
  replied: 'bg-accent/85',
  opportunity: 'bg-accent',
  lost: 'bg-ink-muted/30',
};

export function FunnelChart({
  stages,
  lost,
}: {
  stages: readonly FunnelStageView[];
  lost: number;
}) {
  const top = stages[0]?.reached ?? 0;

  if (top === 0) {
    return (
      <p className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
        No leads yet. Start a campaign and this fills in as people move through it.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {stages.map((stage, index) => {
        const previous = stages[index - 1];
        // Conversion against the stage above, not against the top of the
        // funnel: "40% of the people we researched were worth writing to" is
        // actionable, while "40% of everyone we ever found" is not.
        const rate =
          previous && previous.reached > 0
            ? Math.round((stage.reached / previous.reached) * 100)
            : undefined;

        const width =
          top > 0 ? Math.max((stage.reached / top) * 100, stage.reached > 0 ? 4 : 0) : 0;

        return (
          <div key={stage.stage}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="font-medium">{stage.label}</span>
              <span className="text-ink-muted tabular-nums">
                {stage.reached}
                {rate !== undefined ? <span className="ml-2 text-xs">{rate}%</span> : null}
              </span>
            </div>

            <div className="bg-surface-raised mt-1 h-7 w-full overflow-hidden rounded-lg">
              <div
                className={`h-full rounded-lg ${STAGE_TONE[stage.stage] ?? 'bg-accent/40'}`}
                style={{ width: `${width}%` }}
              />
            </div>

            {stage.current > 0 ? (
              <p className="text-ink-muted mt-1 text-xs">{stage.current} sitting here now</p>
            ) : null}
          </div>
        );
      })}

      {lost > 0 ? (
        <p className="text-ink-muted mt-2 text-xs">
          {lost} left the funnel — not interested, or suppressed.
        </p>
      ) : null}
    </div>
  );
}

/**
 * One row per lead, each stage a segment along a shared time axis.
 *
 * This is the "sideways chart" — a Gantt in the only sense that matters here:
 * you can see at a glance which leads flew through and which have been sitting
 * in one stage for a week. Segment width is time spent, so a stall is visibly
 * wide rather than a number someone has to compare.
 */
export function LeadTimelineChart({ leads }: { leads: readonly LeadTimelineView[] }) {
  if (leads.length === 0) {
    return (
      <p className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
        Nothing has moved yet.
      </p>
    );
  }

  // One shared scale across every row, so two rows of the same width really
  // did take the same time. Per-row scaling would make a lead that took an
  // hour look identical to one that took a fortnight.
  const span = Math.max(...leads.map((lead) => totalHours(lead)), 1);

  return (
    <div className="flex flex-col gap-3">
      {leads.map((lead) => (
        <div key={lead.personId}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <Link href={`/prospects/${lead.personId}`} className="truncate font-medium">
              {lead.personName}
              {lead.companyName ? (
                <span className="text-ink-muted font-normal"> · {lead.companyName}</span>
              ) : null}
            </Link>
            <span className="text-ink-muted shrink-0 text-xs">
              {STAGE_LABEL[lead.currentStage] ?? lead.currentStage}
            </span>
          </div>

          <div className="bg-surface-raised mt-1 flex h-5 w-full overflow-hidden rounded-lg">
            {lead.segments.map((segment, index) => {
              // The last segment is still open, so it gets whatever is left
              // rather than a zero width — a lead sitting in a stage right now
              // is exactly the one worth seeing.
              const hours = segment.hours ?? Math.max(span - elapsedBefore(lead, index), 0.5);
              const width = Math.max((hours / span) * 100, 3);

              return (
                <div
                  key={`${segment.stage}-${segment.enteredAt}`}
                  className={STAGE_TONE[segment.stage] ?? 'bg-accent/40'}
                  style={{ width: `${width}%` }}
                  title={`${STAGE_LABEL[segment.stage] ?? segment.stage} · ${formatHours(hours)}`}
                />
              );
            })}
          </div>
        </div>
      ))}

      <StageKey />
    </div>
  );
}

function StageKey() {
  return (
    <ul className="text-ink-muted mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
      {STAGE_ORDER.map((stage) => (
        <li key={stage} className="flex items-center gap-1.5">
          <span className={`inline-block h-2.5 w-2.5 rounded-sm ${STAGE_TONE[stage]}`} />
          {STAGE_LABEL[stage]}
        </li>
      ))}
    </ul>
  );
}

function totalHours(lead: LeadTimelineView): number {
  const first = Date.parse(lead.firstSeenAt);
  if (Number.isNaN(first)) return 1;
  return Math.max((Date.now() - first) / 3_600_000, 1);
}

function elapsedBefore(lead: LeadTimelineView, index: number): number {
  return lead.segments.slice(0, index).reduce((total, segment) => total + (segment.hours ?? 0), 0);
}

function formatHours(hours: number): string {
  if (hours < 1) return 'under an hour';
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

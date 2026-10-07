/**
 * The Outreach Planner: twelve months of outreach plays, run by the worker.
 *
 * Hunter's planner (hunter.io/pdf/hunter-outreach-planner.pdf) maps a B2B
 * year onto the four engines — lists, messages, relationships, learning — and
 * gives every month a buying mode, a sequence type and a play: who to write to
 * and with what angle. Most of a month's work is mechanical once the data is
 * there: "anyone who opened or clicked Month 1 but never replied gets a case
 * study", "everyone engaged in Q3 gets a year-end invite". That part is here,
 * as data the planner engine executes on the first sweep of each month.
 *
 * What the plan does *not* need a month for is already continuous elsewhere:
 * verify-before-send and the 2% bounce gate (`list-quality.ts`), account
 * expansion one persona at a time (`personas.ts`), A/B winners promoted at 50+
 * per arm (`ab-testing.ts`), business hours and the 7-day bump (`timing.ts`).
 *
 * Quarters are calendar quarters, as in the planner: Q1 is January to March.
 */

export type BuyingMode =
  | 'final_approval'
  | 'evaluating_options'
  | 'researching_solutions'
  | 'competitor_displacement'
  | 'problem_identification';

export type SequenceType = 'direct' | 'value_first' | 'relationship' | 'experiment';

/**
 * Who a play writes to, by what they did with earlier outreach.
 *
 * - `engaged_no_reply` — opened or clicked, never replied.
 * - `no_reply` — written to, never replied (engaged or not).
 * - `unengaged` — written to; no open, click or reply.
 * - `engaged` — opened, clicked, or replied with interest or a question.
 */
export type Engagement = 'engaged_no_reply' | 'no_reply' | 'unengaged' | 'engaged';

export interface Segment {
  readonly engagement: Engagement;
  /**
   * Which earlier outreach counts, by when the person was first written to:
   * calendar quarters of the current year, or the last N days.
   */
  readonly contacted: { readonly quarters: readonly number[] } | { readonly lastDays: number };
  /** People already reached by these plays this year are left out. */
  readonly excludePlays?: readonly string[];
}

export interface PlayTouch {
  /** Hours after the previous touch (the first is 0). */
  readonly delayHours: number;
  /** The angle the composer is asked to take. Grounding rules still apply. */
  readonly intent: string;
  /**
   * An alternate angle, A/B tested against `intent` (experiment months).
   * The planner substitutes the workspace's latest winning angle for
   * `{{winner}}` when one exists, and drops the variant when none does.
   */
  readonly variant?: string;
}

export interface Play {
  readonly key: string;
  readonly title: string;
  readonly sequence: SequenceType;
  readonly segment: Segment;
  readonly touches: readonly PlayTouch[];
}

export interface PlannerMonth {
  readonly quarter: 1 | 2 | 3 | 4;
  /** 1-3 within the quarter. */
  readonly month: 1 | 2 | 3;
  readonly label: string;
  readonly buyingMode: BuyingMode;
  readonly whatBuyersAreDoing: string;
  readonly benchmark: string;
  /** Plays launched from existing engagement data. */
  readonly plays: readonly Play[];
  /** Whether this month refreshes the target-audience list (re-reads each seed). */
  readonly refreshLists: boolean;
}

const DIRECT_FOLLOW_UPS: readonly PlayTouch[] = [
  {
    delayHours: 72,
    intent:
      'Short follow-up in the same thread: restate the one question from the first message in a single sentence.',
  },
  {
    delayHours: 96,
    intent:
      'Last touch: one sentence acknowledging they are busy and leaving the door open, with the same question.',
  },
];

export const PLANNER_YEAR: readonly PlannerMonth[] = [
  {
    quarter: 1,
    month: 1,
    label: 'Three-list sequence to fresh-budget buyers',
    buyingMode: 'final_approval',
    whatBuyersAreDoing:
      'Active and budget-aware with energy to make decisions; some have named the problem, some are evaluating.',
    benchmark: '2-4% reply rate on a fresh list; above 2% bounce, stop and re-verify.',
    refreshLists: true,
    plays: [],
  },
  {
    quarter: 1,
    month: 2,
    label: 'Case study to non-responders',
    buyingMode: 'evaluating_options',
    whatBuyersAreDoing:
      'Anyone who did not reply last month needs a reason to look again as they shortlist.',
    benchmark: '20-30% open rate, 3-5% reply rate.',
    refreshLists: false,
    plays: [
      {
        key: 'case_study_non_responders',
        title: 'Case study to non-responders',
        sequence: 'value_first',
        segment: { engagement: 'engaged_no_reply', contacted: { lastDays: 60 } },
        touches: [
          {
            delayHours: 0,
            intent:
              'Value first: share one useful result, finding or example that matches their situation. One sentence on why it is relevant to them, one on what it shows. Close with a low-friction question like "Worth a look?". No meeting ask.',
          },
        ],
      },
    ],
  },
  {
    quarter: 1,
    month: 3,
    label: 'Roundtable invite to slow movers',
    buyingMode: 'researching_solutions',
    whatBuyersAreDoing:
      'Closing with other vendors; now is the time to build the relationship and connect them with peers.',
    benchmark: '5-8% reply rate on roundtable, podcast or survey invites.',
    refreshLists: false,
    plays: [
      {
        key: 'roundtable_slow_movers',
        title: 'Roundtable invite to slow movers',
        sequence: 'relationship',
        segment: {
          engagement: 'no_reply',
          contacted: { lastDays: 90 },
          excludePlays: ['case_study_non_responders'],
        },
        touches: [
          {
            delayHours: 0,
            intent:
              'Relationship, not a pitch: invite them to a small peer conversation (a roundtable or a short interview) about the problem area, opened with something specific to their role. No product ask.',
            variant:
              'Relationship, not a pitch: ask for five minutes of their view on the problem area for a short survey, promising to share what peers said. No product ask.',
          },
        ],
      },
    ],
  },
  {
    quarter: 2,
    month: 1,
    label: 'Switcher sequence to displaced buyers',
    buyingMode: 'competitor_displacement',
    whatBuyersAreDoing:
      'Three months in with a competitor and the cracks show. Ask what their current solution is not answering.',
    benchmark: '3-5% reply rate on switcher lists.',
    refreshLists: true,
    plays: [
      {
        key: 'switchers_q1_unengaged',
        title: 'Competitor-aware angle to Q1 unengaged',
        sequence: 'direct',
        segment: { engagement: 'unengaged', contacted: { quarters: [1] } },
        touches: [
          {
            delayHours: 0,
            intent:
              'Direct, competitor-aware: ask one question about a gap their current tooling commonly leaves (only gaps the CONTEXT supports) and how this addresses it. Plain text, one question that takes ten seconds to answer.',
          },
          ...DIRECT_FOLLOW_UPS,
        ],
      },
    ],
  },
  {
    quarter: 2,
    month: 2,
    label: 'Second touch to Q1 carryovers',
    buyingMode: 'final_approval',
    whatBuyersAreDoing: 'Q1 carryovers are getting closer to converting; give them a timely nudge.',
    benchmark: 'Up to 46% reply lift when a second contact is reached.',
    refreshLists: false,
    plays: [
      {
        key: 'second_touch_q1_engaged',
        title: 'Second sequence with a new angle to Q1 engaged',
        sequence: 'direct',
        segment: {
          engagement: 'engaged_no_reply',
          contacted: { quarters: [1] },
          excludePlays: ['switchers_q1_unengaged'],
        },
        touches: [
          {
            delayHours: 0,
            intent:
              'Second touch: briefly reference what we sent them earlier this year, then a new angle on the same problem and one clear question.',
          },
          ...DIRECT_FOLLOW_UPS,
        ],
      },
    ],
  },
  {
    quarter: 2,
    month: 3,
    label: 'Research survey to engaged leads',
    buyingMode: 'problem_identification',
    whatBuyersAreDoing:
      'Engaged Q1 leads are getting ready to close; give them a reason to engage.',
    benchmark: '6-8% reply rate from your warmest contacts.',
    refreshLists: false,
    plays: [
      {
        key: 'research_q1_engaged',
        title: 'Research request to Q1 engaged',
        sequence: 'relationship',
        segment: {
          engagement: 'engaged_no_reply',
          contacted: { quarters: [1] },
          excludePlays: ['second_touch_q1_engaged'],
        },
        touches: [
          {
            delayHours: 0,
            intent:
              'Research request: ask three to five quick questions about how they handle the problem area (five minutes at most) and promise to share the results. No product ask.',
            variant:
              'Research request: ask for a fifteen-minute interview about how they handle the problem area, promising a summary of what peers said. No product ask.',
          },
        ],
      },
    ],
  },
  {
    quarter: 3,
    month: 1,
    label: 'Lookalike test + research survey',
    buyingMode: 'problem_identification',
    whatBuyersAreDoing:
      'Senior people are on holiday; part of the audience is reviewing what is not working and is receptive to thoughtful content.',
    benchmark: '2-3% on lookalikes, 6-8% on research requests to engaged contacts.',
    refreshLists: true,
    plays: [
      {
        key: 'research_q2_engaged',
        title: 'Research request to Q2 engaged',
        sequence: 'experiment',
        segment: { engagement: 'engaged_no_reply', contacted: { quarters: [2] } },
        touches: [
          {
            delayHours: 0,
            intent:
              'Research request: ask two or three quick questions about what is not working for them in the problem area and offer to share what peers said. No product ask.',
            variant: '{{winner}}',
          },
          {
            delayHours: 96,
            intent: 'One short follow-up in the same thread repeating the single easiest question.',
          },
        ],
      },
    ],
  },
  {
    quarter: 3,
    month: 2,
    label: 'Repurpose the case study to engaged leads',
    buyingMode: 'researching_solutions',
    whatBuyersAreDoing:
      'Buyers in research mode for a Q4 purchase are reading, comparing and shortlisting.',
    benchmark: '5-8% reply rate on content reactivation.',
    refreshLists: false,
    plays: [
      {
        key: 'reactivate_q1q2_engaged',
        title: 'Content reactivation to Q1+Q2 engaged',
        sequence: 'value_first',
        segment: {
          engagement: 'engaged_no_reply',
          contacted: { quarters: [1, 2] },
          excludePlays: ['research_q2_engaged'],
        },
        touches: [
          {
            delayHours: 0,
            intent:
              'One plain-text email with no links: "this reminded me of you", one specific result or example that fits their situation, and a low-friction "Worth a call?".',
          },
        ],
      },
    ],
  },
  {
    quarter: 3,
    month: 3,
    label: 'Two-list direct outreach to close the quarter',
    buyingMode: 'final_approval',
    whatBuyersAreDoing:
      'Active and budget-aware with shortlists in hand: the highest-intent window of the second half.',
    benchmark: '4-6% reply rate if the Q3 experiments worked.',
    refreshLists: true,
    plays: [
      {
        key: 'direct_q3_warm',
        title: 'Direct outreach to warm Q3',
        sequence: 'direct',
        segment: { engagement: 'engaged', contacted: { quarters: [3] } },
        touches: [
          {
            delayHours: 0,
            intent:
              'Direct: reference what we sent them this quarter, state the outcome plainly, and ask one question about timing.',
          },
          ...DIRECT_FOLLOW_UPS,
        ],
      },
    ],
  },
  {
    quarter: 4,
    month: 1,
    label: 'Urgency sequence + calculator play',
    buyingMode: 'evaluating_options',
    whatBuyersAreDoing:
      'Buyers who engaged across the year are finalizing decisions and preparing for next year.',
    benchmark: '6-10% reply rate from your warmest contacts.',
    refreshLists: false,
    plays: [
      {
        key: 'urgency_q3_engaged',
        title: 'Time-anchored close to Q3 engaged',
        sequence: 'direct',
        segment: { engagement: 'engaged_no_reply', contacted: { quarters: [3] } },
        touches: [
          {
            delayHours: 0,
            intent:
              'Direct and time-anchored: reference the engagement we saw, note that planning for the start of next year is happening now, and ask for a 15-minute call this week or next. No invented deadlines or discounts.',
          },
          ...DIRECT_FOLLOW_UPS,
        ],
      },
      {
        key: 'cost_q1q2_engaged',
        title: '"What is it costing you?" to Q1+Q2 engaged',
        sequence: 'value_first',
        segment: {
          engagement: 'engaged_no_reply',
          contacted: { quarters: [1, 2] },
          excludePlays: ['urgency_q3_engaged'],
        },
        touches: [
          {
            delayHours: 0,
            intent:
              'Value first, self-serve: frame one question as "what is this problem costing you?" using only what the CONTEXT supports, and invite a one-line answer. No meeting ask.',
          },
        ],
      },
    ],
  },
  {
    quarter: 4,
    month: 2,
    label: 'Year-end invite to engaged Q3',
    buyingMode: 'final_approval',
    whatBuyersAreDoing:
      'Last calls of the year; anyone still evaluating wraps up now or carries into Q1.',
    benchmark: '5-10% reply rate on roundtable, research or podcast invites.',
    refreshLists: false,
    plays: [
      {
        key: 'year_end_invite_q3',
        title: 'Year-end invite to engaged Q3',
        sequence: 'relationship',
        segment: {
          engagement: 'engaged_no_reply',
          contacted: { quarters: [3] },
          excludePlays: ['urgency_q3_engaged'],
        },
        touches: [
          {
            delayHours: 0,
            intent:
              'Relationship: invite them to a small year-end peer conversation about the problem area and what is changing next year. No product ask.',
            variant: '{{winner}}',
          },
        ],
      },
    ],
  },
  {
    quarter: 4,
    month: 3,
    label: 'Personal check-ins to your best relationships',
    buyingMode: 'problem_identification',
    whatBuyersAreDoing:
      'Most buyers are taking a break; a personal touch now ensures a call to start the next year.',
    benchmark: 'The output this month is a ready Q1 plan, not reply rates.',
    refreshLists: true,
    plays: [
      {
        key: 'year_end_check_in',
        title: 'Personal check-in to everyone engaged this year',
        sequence: 'relationship',
        segment: { engagement: 'engaged', contacted: { quarters: [1, 2, 3, 4] } },
        touches: [
          {
            delayHours: 0,
            intent:
              'A short personal check-in: one specific reference to their year from the CONTEXT, and "if I can help as you plan, just reply". No pitch.',
          },
        ],
      },
    ],
  },
];

/** The plan for the calendar month `at` falls in (UTC). */
export function plannerMonth(at: Date): PlannerMonth {
  return PLANNER_YEAR[at.getUTCMonth()] as PlannerMonth;
}

/** `YYYY-MM`, the planner's unit of idempotency. */
export function plannerPeriod(at: Date): string {
  return at.toISOString().slice(0, 7);
}

/** Start and end (exclusive) of calendar quarter `q` in `year`, as ISO strings. */
export function quarterRange(year: number, quarter: number): { from: string; to: string } {
  const from = new Date(Date.UTC(year, (quarter - 1) * 3, 1));
  const to = new Date(Date.UTC(year, quarter * 3, 1));
  return { from: from.toISOString(), to: to.toISOString() };
}

/**
 * The play's touches as cadence steps, with `{{winner}}` replaced by the
 * workspace's latest winning angle — or the variant dropped when there is no
 * winner yet, or when the winner is the intent itself.
 */
export function touchesWithWinner(
  touches: readonly PlayTouch[],
  winner: string | undefined,
): Array<{ delayHours: number; intent: string; variants: string[] }> {
  return touches.map((touch) => {
    const variant =
      touch.variant === '{{winner}}' ? winner?.trim() || undefined : touch.variant?.trim();
    return {
      delayHours: touch.delayHours,
      intent: touch.intent,
      variants: variant && variant.toLowerCase() !== touch.intent.toLowerCase() ? [variant] : [],
    };
  });
}

export const BUYING_MODE_LABELS: Readonly<Record<BuyingMode, string>> = {
  final_approval: 'Final approval',
  evaluating_options: 'Evaluating options',
  researching_solutions: 'Researching solutions',
  competitor_displacement: 'Competitor displacement',
  problem_identification: 'Problem identification',
};

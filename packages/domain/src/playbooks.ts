/**
 * Prepackaged plays, so a new workspace never sees a blank form.
 *
 * The empty state is this product's hardest screen. Everything downstream —
 * discovery, signals, scoring, drafting — works well once a campaign describes
 * a real market and a real trigger, and not at all when someone types "founders"
 * because the box was empty and they wanted to see what happened.
 *
 * A playbook is three things a working campaign needs and a blank form asks for
 * separately: what to look for, what should make us act, and what the sequence
 * of touches is. Nothing here is magic — each field is exactly what a user
 * could have typed — and that is the point. A playbook is a worked example
 * that happens to be executable.
 *
 * Deliberately data, not code. These are edited far more often than the engine
 * is, usually by whoever last talked to a customer, and a change here should
 * never need a migration.
 */

import type { ActionKind, Network } from './networks';

export interface PlaybookStep {
  readonly network: Network;
  readonly action: ActionKind;
  /** Hours after the previous step. The first step's delay is from enrollment. */
  readonly delayHours: number;
  /** What this touch is for. Guidance for the composer, never a template. */
  readonly intent: string;
}

export interface Playbook {
  readonly slug: string;
  readonly name: string;
  /** One line, shown in the picker. */
  readonly summary: string;
  /** Who this is for, in the words the user would use. */
  readonly audience: string;
  /**
   * The campaign brief, as if typed into the intake box. This is what the
   * discovery and ICP work actually reads.
   */
  readonly intake: string;
  /** Phrases worth listening for. Expanded further at run time. */
  readonly keywords: readonly string[];
  readonly steps: readonly PlaybookStep[];
  /** Questions worth asking of every prospect this play finds. */
  readonly gridQuestions: readonly string[];
}

/**
 * The library.
 *
 * Every play here opens on a public, non-intrusive touch where the network
 * allows one, and reaches email second. That ordering is PRD §13.3 made
 * concrete: joining a conversation someone is already having is a smaller
 * imposition than arriving in their inbox, and it works better.
 */
export const PLAYBOOKS: readonly Playbook[] = [
  {
    slug: 'competitor-switchers',
    name: 'Competitor switchers',
    summary: 'People publicly unhappy with the tool you replace.',
    audience: 'Anyone whose product displaces a named incumbent.',
    intake:
      'Find people publicly complaining about the tool we replace, or asking for ' +
      'alternatives to it, and start a conversation about what specifically is not ' +
      'working for them.',
    keywords: ['looking for an alternative to', 'migrating off', 'fed up with', 'switching from'],
    steps: [
      {
        network: 'bluesky',
        action: 'reply',
        delayHours: 0,
        intent: 'answer the specific complaint usefully, without pitching',
      },
      {
        network: 'email',
        action: 'send_email',
        delayHours: 72,
        intent: 'reference the exchange and offer something concrete',
      },
    ],
    gridQuestions: [
      'Which competing tool are they currently using?',
      'What specifically are they unhappy about?',
      'Have they said they are actively evaluating alternatives?',
    ],
  },
  {
    slug: 'hiring-signal',
    name: 'Hiring for the problem',
    summary: 'Companies staffing up against the thing you automate.',
    audience: 'Tools that replace or assist a role a company is hiring for.',
    intake:
      'Find companies hiring for roles that exist because of the problem we solve, ' +
      'and reach the person who owns that function rather than the recruiter.',
    keywords: ['we are hiring', 'join our team', 'now hiring', 'open role'],
    steps: [
      {
        network: 'email',
        action: 'send_email',
        delayHours: 0,
        intent: 'reference the specific role and what it implies about their roadmap',
      },
      {
        network: 'linkedin',
        action: 'view_profile',
        delayHours: 48,
        intent: 'a light, human touch while the email is still recent',
      },
      {
        network: 'email',
        action: 'send_email',
        delayHours: 120,
        intent: 'one useful follow-up, then stop',
      },
    ],
    gridQuestions: [
      'What role are they hiring for, and at what seniority?',
      'What does that role suggest they are building this quarter?',
      'Who owns this function today?',
    ],
  },
  {
    slug: 'maintainer-pain',
    name: 'Maintainers in pain',
    summary: 'Open-source maintainers hitting the wall your tool removes.',
    audience: 'Developer tooling, where the wedge is a public repository.',
    intake:
      'Find maintainers of active repositories who are publicly hitting the problem ' +
      'we solve — flaky builds, slow pipelines, dependency pain — and be useful in ' +
      'the conversation they are already having.',
    keywords: ['flaky test', 'CI is so slow', 'build keeps failing', 'dependency hell'],
    steps: [
      {
        network: 'bluesky',
        action: 'reply',
        delayHours: 0,
        intent: 'answer the technical problem on its own terms',
      },
      {
        network: 'email',
        action: 'send_email',
        delayHours: 96,
        intent: 'only if the reply landed — offer to look at their setup',
      },
    ],
    gridQuestions: [
      'What is the technical problem they described?',
      'How large and how active is the project?',
      'Are they the maintainer, or a contributor?',
    ],
  },
  {
    slug: 'funding-announced',
    name: 'Just raised',
    summary: 'Companies with new budget and a public mandate to spend it.',
    audience: 'Anything with a real price tag that needs a budget holder.',
    intake:
      'Find companies that have just announced funding and reach the person who now ' +
      'owns the problem we solve, while the mandate is fresh.',
    keywords: ['excited to announce', 'we raised', 'seed round', 'series a'],
    steps: [
      {
        network: 'bluesky',
        action: 'like',
        delayHours: 0,
        intent: 'a small, honest acknowledgement before anything else',
      },
      {
        network: 'email',
        action: 'send_email',
        delayHours: 24,
        intent: 'congratulate briefly, then be specific about the next six months',
      },
    ],
    gridQuestions: [
      'How much did they raise, and at what stage?',
      'What did they say the money is for?',
      'Who would own this purchase?',
    ],
  },
];

export function playbookBySlug(slug: string): Playbook | undefined {
  return PLAYBOOKS.find((playbook) => playbook.slug === slug);
}

/**
 * Total elapsed time of a play, in hours. Shown in the picker so "three
 * touches" also reads as "over a week".
 */
export function playbookDurationHours(playbook: Playbook): number {
  return playbook.steps.reduce((total, step) => total + step.delayHours, 0);
}

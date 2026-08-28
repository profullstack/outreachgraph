/**
 * Inline instructions: where you are in the process, what you have to do next,
 * and what the machine is doing while you read it.
 *
 * The complaint this answers is that the app never says what the process *is*.
 * Every screen was written for someone who already knew that a profile feeds a
 * campaign, a campaign feeds a crawl, a crawl produces signals, signals produce
 * drafts and drafts wait for a human. Each page was clear on its own and the
 * sequence joining them existed only in the PRD.
 *
 * Two rules hold this together:
 *
 * 1. **The action items are computed, never written.** A hard-coded "connect
 *    your mailbox" that stays up after you connected one is worse than no
 *    guidance, because it teaches the reader to ignore the panel. Everything
 *    below is derived from the same state the API reports.
 * 2. **The same list on every page.** "What do I do next" has one answer for a
 *    workspace, and it must not change depending on which tab is open — only
 *    the *step* marker is page-specific.
 */

import {
  fetchApprovals,
  fetchCampaignSummaries,
  fetchMe,
  fetchProfile,
  fetchStatus,
  type WorkflowStatusView,
} from './api';

// --------------------------------------------------------------- the process

export type StepId = 'profile' | 'campaign' | 'research' | 'draft' | 'approve' | 'watch';

export interface PipelineStep {
  readonly id: StepId;
  readonly label: string;
  /** Where the step is done. Absent when nobody does it by hand. */
  readonly href?: string;
  /** True when it runs without anyone present. */
  readonly automatic?: boolean;
  readonly blurb: string;
}

/**
 * The whole product, in the order it actually happens.
 *
 * Steps 3 and 4 have no href on purpose. Someone waiting for prospects to
 * appear needs to know the wait is the system working rather than a page they
 * failed to find, and a link would imply there is something to go and do.
 */
export const PIPELINE: readonly PipelineStep[] = [
  {
    id: 'profile',
    label: 'Say what you sell',
    href: '/setup',
    blurb:
      'We read your website and draft your offering, who buys it and the voice to write in. Every message is grounded in this, so it comes first.',
  },
  {
    id: 'campaign',
    label: 'Say who to reach',
    href: '/outreach',
    blurb:
      'Paste company websites, or describe the market in a sentence. Each product gets its own campaign.',
  },
  {
    id: 'research',
    label: 'We research and score them',
    automatic: true,
    blurb:
      'The worker reads those sites, finds the people at them, works out who they are across networks, collects public signals and ranks each one against your buyers. This takes minutes, not seconds.',
  },
  {
    id: 'draft',
    label: 'We write the message',
    automatic: true,
    blurb:
      'When a signal is worth acting on, a draft is written for that person and queued for you. Weak matches never get one.',
  },
  {
    id: 'approve',
    label: 'You approve it',
    href: '/approvals',
    blurb:
      'Nothing goes out without you unless you put the campaign on autopilot. Email sends from here; social posts you make yourself, in the network’s own app.',
  },
  {
    id: 'watch',
    label: 'Watch what comes back',
    href: '/funnel',
    blurb: 'Stages, replies, and anything that has been sitting in one place too long.',
  },
];

// ------------------------------------------------------------ per-page copy

export type PageId =
  | 'today'
  | 'setup'
  | 'products'
  | 'team'
  | 'outreach'
  | 'prospects'
  | 'prospect'
  | 'signals'
  | 'approvals'
  | 'funnel'
  | 'settings'
  | 'more';

export interface PageCopy {
  /** Which stage of the pipeline this screen belongs to, if any. */
  readonly step?: StepId;
  /** Shown instead of a step number on the screens that sit outside the flow. */
  readonly chip?: string;
  /** One sentence: what this screen is. Always visible. */
  readonly what: string;
  /** What you are expected to do here. */
  readonly you: string;
  /** What happens here without you. */
  readonly ours: string;
  /** The thing that reliably confuses people about this screen. */
  readonly note?: string;
}

export const PAGE_COPY: Record<PageId, PageCopy> = {
  today: {
    chip: 'Overview',
    what: 'Your home screen: everything waiting on you, and whether the pipeline is running.',
    you: 'Read the queue and clear anything waiting. Start here each day.',
    ours: 'We keep working in the background whether or not this page is open.',
    note: 'An empty queue means one of two things, and the panel below tells you which: nothing has been researched yet, or nothing researched is worth writing to.',
  },
  setup: {
    step: 'profile',
    what: 'What you sell, who buys it, and how you sound.',
    you: 'Paste your website and correct the draft we come back with.',
    ours: 'We read the site and fill this in for you, then ground every future message in it.',
    note: 'One product per profile. A workspace selling two things needs two, because the buyers, claims and voice are all different.',
  },
  products: {
    chip: 'Overview',
    what: 'Everything this workspace sells, and the campaign each one runs.',
    you: 'Add a product for each thing you sell, and pick the right one when you start a campaign.',
    ours: 'We keep each product’s claims, buyers and voice apart, so a draft never pitches the wrong thing.',
    note: 'Archiving a product stops its campaign. Nothing already sent is deleted.',
  },
  team: {
    chip: 'Overview',
    what: 'Everyone who can see this account, and anyone invited but not yet answered.',
    you: 'Invite colleagues by email and pick what each of them may do.',
    ours: 'We mail them a link that works whether or not they already have an account.',
    note: 'Access is to the whole organization, and the plan is billed to it — so an invited teammate shares this month’s allowance rather than getting their own.',
  },
  outreach: {
    step: 'campaign',
    what: 'Where a run starts. Everything downstream begins with what you enter here.',
    you: 'Enter company websites, or describe the market you want to reach.',
    ours: 'We turn that into a campaign and start crawling. Results take minutes to appear.',
    note: 'Nothing appears instantly. Watch the line above, or the Funnel tab, rather than reloading this page.',
  },
  prospects: {
    step: 'research',
    what: 'Everyone we have found so far, ranked by how good a fit they look.',
    you: 'Nothing, usually. Open someone to check the evidence before you approve writing to them.',
    ours: 'We add people here as crawls finish, then re-score them as new signals arrive.',
    note: 'A low identity confidence means we are not yet sure this is one real person. Those are deliberately not contactable.',
  },
  prospect: {
    step: 'research',
    what: 'One person: who we think they are, and what we can prove.',
    you: 'Check the sources before approving anything written to them.',
    ours: 'We link their profiles across networks and attach every signal to its source.',
    note: 'Company profiles are their employer’s accounts, not theirs. On most sites that is the only social route there is.',
  },
  signals: {
    step: 'research',
    what: 'The raw public activity behind every score, newest first.',
    you: 'Skim it. This is the evidence, not a to-do list.',
    ours: 'We collect these from public sources and let them decay, so old news stops driving outreach.',
    note: 'Signals arriving with no drafts appearing is normal: a signal has to be relevant enough to be worth a message.',
  },
  approvals: {
    step: 'approve',
    what: 'Everything the system wants to do, waiting for your decision.',
    you: 'Approve, edit or reject. Approved email sends immediately.',
    ours: 'We write the draft and rank the queue. We do not send without you unless the campaign is on autopilot.',
    note: 'Cards under Research have no message by design; they are internal work the prospect never sees. Start on the Ready tab.',
  },
  funnel: {
    step: 'watch',
    what: 'Where every lead stands, and what has gone out this week.',
    you: 'Look for stages that are filling up but not emptying.',
    ours: 'We record every stage change, so these are real totals rather than a snapshot.',
    note: 'A wide row in the timeline is a lead that has been stuck in one stage a long time.',
  },
  settings: {
    chip: 'Controls',
    what: 'Your sending mailbox, your alerts, and the limits autopilot has to obey.',
    you: 'Connect the mailbox you want outreach to leave from, and set the daily cap.',
    ours: 'We enforce these limits on every send, including unattended ones.',
    note: 'Without your own mailbox, outreach still sends, but from our domain rather than yours.',
  },
  more: {
    chip: 'Everything else',
    what: 'The screens that do not need a tab of their own.',
    you: 'Nothing. This is a directory.',
    ours: 'Nothing runs from this page.',
  },
};

// ---------------------------------------------------------------- next steps

export interface NextAction {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly href: string;
  /** Nothing downstream can work until this is done. */
  readonly blocking: boolean;
}

interface GuideState {
  readonly verified: boolean;
  readonly configured: boolean;
  /**
   * Whether any campaign has actually been given something to work on.
   *
   * Not a count of campaigns: registering seeds an empty "First campaign", so
   * every workspace has one from its first second and "you have no campaigns"
   * is a state no real user is ever in. Asking whether a campaign has people,
   * queued work or a seed is the question that was meant all along.
   */
  readonly started: boolean;
  readonly ready: number;
  readonly status?: WorkflowStatusView;
}

/**
 * What to do next, in the order the product needs it done.
 *
 * Deliberately ordered by dependency rather than by importance: confirming an
 * email address is a chore, but every model-backed action is gated on it, so a
 * workspace that skips it looks broken in a way none of the other advice can
 * explain.
 *
 * The three setup steps are listed together rather than revealed one at a
 * time. Showing only the next one hides how much is left, and a page that
 * suppresses the rest until the first is done cannot be read as a checklist —
 * which is precisely what someone who does not yet know the process needs.
 */
export function nextActions(state: GuideState): readonly NextAction[] {
  const actions: NextAction[] = [];

  if (!state.verified) {
    actions.push({
      id: 'verify',
      label: 'Confirm your email address',
      detail: 'We check it before running anything that costs money. The link is in your inbox.',
      href: '/today',
      blocking: true,
    });
  }

  if (!state.configured) {
    actions.push({
      id: 'profile',
      label: 'Tell us what you sell',
      detail:
        'Until you do, drafts quote placeholder text and scoring has no idea who a good fit is.',
      href: '/setup',
      blocking: true,
    });
  }

  if (!state.started) {
    actions.push({
      id: 'campaign',
      label: 'Start your first campaign',
      detail:
        'Enter a company website, or describe the market you want to reach. Nothing runs until you do.',
      href: '/outreach',
      blocking: true,
    });
  }

  if (state.ready > 0) {
    actions.push({
      id: 'approve',
      label: `Review ${state.ready} ${state.ready === 1 ? 'draft' : 'drafts'} waiting for you`,
      detail: 'Written, ranked and ready to send. Nothing goes out until you say so.',
      href: '/approvals',
      blocking: false,
    });
  }

  // Only worth raising once there is outreach to send. On a brand new
  // workspace it is noise stacked on top of the three steps that matter, and
  // the seeded empty campaign means a count of campaigns cannot tell them
  // apart.
  if (state.started && state.status && !state.status.sending.configured) {
    actions.push({
      id: 'mailbox',
      label: 'Connect your own mailbox',
      detail: 'Optional. Without it, outreach goes out from our domain instead of yours.',
      href: '/settings',
      blocking: false,
    });
  }

  if (state.status?.sending.configured && !state.status.sending.verified) {
    actions.push({
      id: 'verify-mailbox',
      label: 'Verify your mailbox',
      detail: 'It is connected but unverified, so outreach still leaves from our domain.',
      href: '/settings',
      blocking: false,
    });
  }

  if (state.status && state.status.queue.failed > 0) {
    actions.push({
      id: 'failed',
      label: `${state.status.queue.failed} background ${
        state.status.queue.failed === 1 ? 'job has' : 'jobs have'
      } failed`,
      detail: 'The running commentary on Today names what broke.',
      href: '/today',
      blocking: false,
    });
  }

  return actions;
}

// ------------------------------------------------------------------ loading

export interface GuideView {
  readonly copy: PageCopy;
  readonly stepIndex: number;
  readonly actions: readonly NextAction[];
  readonly status?: WorkflowStatusView;
  /**
   * Whether any campaign has been given work. An idle queue means two
   * different things either side of this, and the live line cannot tell them
   * apart from the status block alone.
   */
  readonly started: boolean;
  /** False when the API could not be reached; the panel then says only that. */
  readonly reachable: boolean;
}

/**
 * Everything the panel needs, and never a thrown error.
 *
 * Guidance is the one thing on a page that must not be able to take the page
 * down with it — a panel explaining how the product works is worthless if a
 * slow aggregate query turns the screen it explains into a stack trace. Each
 * read is allowed to fail on its own and the panel degrades to what it still
 * knows.
 *
 * The reads themselves are deduplicated by `cache()` in `lib/api`, so on the
 * pages that already fetch this state the panel costs nothing extra.
 */
export async function loadGuide(page: PageId): Promise<GuideView> {
  const copy = PAGE_COPY[page];
  const stepIndex = copy.step ? PIPELINE.findIndex((step) => step.id === copy.step) : -1;

  const [me, profile, campaigns, queue, live] = await Promise.all([
    quiet(() => fetchMe()),
    quiet(() => fetchProfile()),
    quiet(() => fetchCampaignSummaries()),
    // `limit: 1` because only the counts are wanted here; the API totals the
    // whole pending set regardless of what it returns rows for.
    quiet(() => fetchApprovals('ready', 1)),
    quiet(() => fetchStatus()),
  ]);

  const reachable = me !== undefined || live !== undefined;

  // A campaign counts as started once it has been given something to act on:
  // people found, work queued, a seed entered, or any activity at all. The
  // campaign created for you at signup satisfies none of these.
  const started = (campaigns ?? []).some(
    (campaign) =>
      campaign.people > 0 ||
      campaign.jobs_pending > 0 ||
      campaign.last_activity_at !== null ||
      campaign.seed_value !== null ||
      campaign.brief !== null,
  );

  const state: GuideState = {
    verified: me?.emailVerified ?? false,
    configured: profile?.configured ?? false,
    started,
    ready: queue?.counts.buckets.ready ?? 0,
    ...(live ? { status: live.status } : {}),
  };

  return {
    copy,
    stepIndex,
    // With nothing reachable there is no state to reason from, and inventing
    // advice out of defaults would tell a healthy workspace to start over.
    actions: reachable ? nextActions(state) : [],
    ...(live ? { status: live.status } : {}),
    started,
    reachable,
  };
}

/**
 * Runs a read, reporting failure as absence.
 *
 * Every caller here treats a missing answer as "cannot advise on this yet",
 * which is the correct response to an unreachable API and to an unexpected
 * error alike — in both cases the panel has nothing true to say, and saying
 * nothing beats taking the surrounding page down to explain how it works.
 */
async function quiet<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

/**
 * Buyer personas and account expansion (Hunter's outreach planner, run by the
 * worker).
 *
 * Every target company has four people worth reaching, and the planner reaches
 * them one at a time, a month apart, each with its own angle:
 *
 *   1. **Budget holder** — signs off. Reached first, while budgets are fresh.
 *   2. **Pain feeler** — the end user who lives with the problem.
 *   3. **Blocker** — legal, security, IT, finance, procurement: the people who
 *      can say no, brought in before they do.
 *   4. **Champion** — the manager who carries it internally.
 *
 * Two rules come with it, and both are enforced at send time:
 *
 *   - **Never two contacts at one company at once.** While anyone at a company
 *     is mid-sequence (`EXPANSION_GAP_DAYS` since their last message), every
 *     colleague waits.
 *   - **In order.** When several people at one company are queued, the one
 *     whose persona comes earliest goes first, so a company is opened by the
 *     person who can buy and widened from there.
 *
 * Classification is a deterministic reading of the job title: the policy path
 * never asks a model, and a title is what we reliably have.
 */

export const PERSONAS = ['budget_holder', 'pain_feeler', 'blocker', 'champion'] as const;
export type Persona = (typeof PERSONAS)[number];
export type PersonaOrUnknown = Persona | 'unknown';

/** Days after one contact's last message before a colleague may be written to. */
export const EXPANSION_GAP_DAYS = 21;

export const PERSONA_LABELS: Readonly<Record<PersonaOrUnknown, string>> = {
  budget_holder: 'budget holder',
  pain_feeler: 'pain feeler',
  blocker: 'blocker',
  champion: 'champion',
  unknown: 'unclassified',
};

/** What to say to each, so the composer writes a fresh angle per role. */
export const PERSONA_ANGLES: Readonly<Record<PersonaOrUnknown, string>> = {
  budget_holder:
    'Write to the person who owns the budget: lead with the business outcome (pipeline, revenue, cost, risk) and ask one question answerable in ten seconds.',
  pain_feeler:
    'Write to the person who does the work day to day: name the specific friction they live with and how it goes away. No executive framing.',
  blocker:
    'Write to the legal, security, IT or finance reviewer: answer their objection before they raise it (compliance, data handling, integration effort, total cost).',
  champion:
    'Write to the manager who would carry this internally: give them the proof they would forward (a result, a number, a short case) and reference the colleague already in touch.',
  unknown: '',
};

// Order matters: a "VP of Legal" is a blocker before a budget holder, and a
// "Chief Security Officer" likewise. Finance, legal and security titles are
// checked before seniority.
const BLOCKER =
  /\b(legal|counsel|attorney|lawyer|compliance|privacy|security|infosec|ciso|risk|procurement|purchasing|sourcing|vendor management|finance|financial|cfo|controller|comptroller|accounting|accountant|treasury|audit|it manager|it director|head of it|it operations|sysadmin|system administrator|information technology|data protection|dpo|gdpr)\b/i;
const BUDGET =
  /\b(ceo|coo|cto|cmo|cro|cpo|cio|chief|founder|co-?founder|owner|president|vp|vice president|svp|evp|head of|director|general manager|gm|managing director|partner|principal owner|proprietor|board)\b/i;
const CHAMPION =
  /\b(manager|lead|team lead|principal|staff|senior manager|supervisor|coordinator lead|architect)\b/i;
const PAIN =
  /\b(engineer|developer|programmer|designer|analyst|specialist|associate|coordinator|representative|rep|executive assistant|assistant|administrator|operator|technician|marketer|writer|editor|consultant|scientist|researcher|agent|recruiter|sdr|bdr|ae|account executive|support|success|intern)\b/i;

export function classifyPersona(title: string | null | undefined): PersonaOrUnknown {
  const text = (title ?? '').trim();
  if (!text) return 'unknown';
  if (BLOCKER.test(text)) return 'blocker';
  if (BUDGET.test(text)) return 'budget_holder';
  if (CHAMPION.test(text)) return 'champion';
  if (PAIN.test(text)) return 'pain_feeler';
  return 'unknown';
}

/** Position in the expansion order; unclassified people go last. */
export function personaRank(persona: PersonaOrUnknown): number {
  const index = (PERSONAS as readonly string[]).indexOf(persona);
  return index === -1 ? PERSONAS.length : index;
}

/**
 * Orders a send queue so each company's earliest persona comes first, without
 * disturbing the order between companies.
 *
 * A company takes the position of its best-ranked card in the original order
 * (priority already decided that), and its cards follow one another in persona
 * order. Cards with no company keep their own position.
 */
export function orderForExpansion<T>(
  items: readonly T[],
  companyOf: (item: T) => string | null | undefined,
  personaOf: (item: T) => PersonaOrUnknown,
): T[] {
  const firstSeen = new Map<string, number>();
  items.forEach((item, index) => {
    const company = companyOf(item);
    if (company && !firstSeen.has(company)) firstSeen.set(company, index);
  });

  return items
    .map((item, index) => {
      const company = companyOf(item);
      return {
        item,
        index,
        group: company ? (firstSeen.get(company) as number) : index,
        rank: company ? personaRank(personaOf(item)) : 0,
      };
    })
    .sort((a, b) => a.group - b.group || a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.item);
}

// ------------------------------------------------------ engineering buyers

/** Default people kept per company in a capped campaign. */
export const DEFAULT_MAX_PEOPLE_PER_COMPANY = 3;

const ENGINEERING_BUYER_TIERS: readonly RegExp[] = [
  // Owns the engineering budget.
  /\b(cto|chief technology officer|chief technical officer|vp,? (?:of )?engineering|vice president,? (?:of )?engineering|svp,? (?:of )?engineering|head of (?:engineering|software|platform|technology|product engineering)|engineering director|director,? (?:of )?(?:engineering|software engineering|platform))\b/i,
  // Owns the company, so owns the hiring call at 10 to 1000 people.
  /\b(co-?founder|founder|ceo|chief executive|president|owner|managing director|chief product officer|cpo)\b/i,
  // Runs a team that needs the engineers.
  /\b(engineering manager|manager,? engineering|software (?:development )?manager|head of|tech(?:nical)? lead|team lead|lead engineer|principal engineer|staff engineer|architect|vp|vice president|director)\b/i,
  // Fills the seat.
  /\b(technical recruiter|engineering recruiter|recruiter|talent|recruiting|people partner|hr)\b/i,
];

/**
 * Who to keep first when a campaign takes only a few people per company, for
 * an offer of engineering capacity: the CTO / VP or Head of Engineering, then
 * the founder or CEO, then the managers and leads who own a team, then the
 * recruiters. Everyone else, then the untitled, last. Lower is better.
 */
export function engineeringBuyerRank(title: string | null | undefined): number {
  const text = (title ?? '').trim();
  if (!text) return ENGINEERING_BUYER_TIERS.length + 1;
  const tier = ENGINEERING_BUYER_TIERS.findIndex((pattern) => pattern.test(text));
  return tier === -1 ? ENGINEERING_BUYER_TIERS.length : tier;
}

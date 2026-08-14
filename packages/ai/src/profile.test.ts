import { describe, expect, test } from 'bun:test';
import { profileLimits, workspaceProfileSchema } from '@outreachgraph/contracts';
import { StubModel } from './model';
import { draftProfile } from './profile';

const PAGE = 'Loopwright catches agent regressions before your customers do.';

/** A model that answers in full marketing prose, which is what they do. */
function chatty(): StubModel {
  return new StubModel(
    JSON.stringify({
      offering: {
        name: 'Loopwright',
        category: 'developer tooling',
        description: 'Reliability tooling for agent teams.',
        valuePropositions: [
          'Enterprise-grade engineering discipline applied to agent reliability, so teams ship ' +
            'autonomous features without discovering the regressions in production alongside ' +
            'their customers, which is the expensive way to find out.',
        ],
        likelyPains: ['Agents fail silently in production'],
        competitors: [],
      },
      icp: {
        titles: ['Staff Engineer'],
        seniorities: ['senior'],
        industries: ['software'],
        technologies: ['python'],
        keywords: ['agent reliability'],
        exclusions: ['students'],
      },
      voice: { style: 'direct and technical', instructions: 'no hype', maxWords: 120 },
      whereToFind: ['GitHub issues on agent frameworks — people describe failures there.'],
    }),
  );
}

describe('drafting a profile', () => {
  test('a long value proposition survives as a sentence rather than a term', async () => {
    const result = await draftProfile(chatty(), PAGE, 'https://loopwright.io/');

    const [first] = result.draft!.offering.valuePropositions;
    expect(first!.length).toBeGreaterThan(profileLimits.term);
    expect(first!.length).toBeLessThanOrEqual(profileLimits.sentence);
  });

  test('every draft can be saved', async () => {
    // The regression this guards: the draft came back fine and the save then
    // rejected it as "incomplete", because one line the form did not even show
    // was longer than the contract allowed. A draft the contract refuses is a
    // dead end for the person looking at it, so it must not be reachable.
    const result = await draftProfile(chatty(), PAGE, 'https://loopwright.io/');
    const { offering, icp, voice } = result.draft!;

    const parsed = workspaceProfileSchema.safeParse({
      url: 'https://loopwright.io/',
      offering,
      icp,
      voice,
    });

    expect(parsed.success).toBe(true);
  });

  test('a run-on entry is cut on a word boundary and marked', async () => {
    const long = 'reliability '.repeat(60).trim();
    const model = new StubModel(
      JSON.stringify({
        offering: { name: 'Loopwright', valuePropositions: [long] },
        icp: { keywords: [long] },
        voice: { style: 'direct' },
      }),
    );

    const result = await draftProfile(model, PAGE, 'https://loopwright.io/');

    const proposition = result.draft!.offering.valuePropositions[0]!;
    const keyword = result.draft!.icp.keywords[0]!;

    expect(proposition.length).toBeLessThanOrEqual(profileLimits.sentence);
    expect(keyword.length).toBeLessThanOrEqual(profileLimits.term);
    // Whole words either side of the cut, and a mark that says it was cut.
    expect(proposition).toEndWith('reliability…');
    expect(keyword).toEndWith('reliability…');
  });
});

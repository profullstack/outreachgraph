import { describe, expect, test } from 'bun:test';
import {
  brainPath,
  mergeAudiences,
  parseBrainFiles,
  parseFrontmatter,
  parseSamples,
  renderBrain,
  replyExcerpt,
  summariseObjections,
  type BrainProfile,
} from './brain';

const PROFILE: BrainProfile = {
  product: {
    offeringId: 'off_1',
    name: 'ExamplePay: payouts',
    url: 'https://examplepay.dev',
    category: 'developer payments',
    description: 'Cross-border payouts for platforms.\n\nSettles in a day.',
    valuePropositions: ['Settles in 24 hours', 'One API for 40 countries'],
    likelyPains: ['Wires take a week'],
    competitors: ['Stripe Connect', 'Wise'],
  },
  voice: {
    style: 'direct, specific, no hype',
    instructions: 'Lead with the problem. Never use exclamation marks.',
    maxWords: 120,
    samples: ['Saw your post about payouts.\n\nWe fixed the same thing.', 'Short and plain.'],
    prohibitedClaims: ['guaranteed delivery', 'bank-grade'],
  },
};

describe('frontmatter', () => {
  test('reads scalars, inline lists and dash lists', () => {
    const { data, body } = parseFrontmatter(
      '---\nproduct: "A: B"\ntags: [one, "two, three"]\nitems:\n  - x\n  - "y"\nn: 5 # comment\n---\n# Hi\n',
    );
    expect(data.product).toBe('A: B');
    expect(data.tags).toEqual(['one', 'two, three']);
    expect(data.items).toEqual(['x', 'y']);
    expect(data.n).toBe('5');
    expect(body).toBe('# Hi\n');
  });

  test('a file without frontmatter is all body', () => {
    expect(parseFrontmatter('# Title').data).toEqual({});
  });
});

describe('renderBrain', () => {
  test('writes the shared layout, flat or under a slug', () => {
    const files = renderBrain(PROFILE, { exportedAt: '2026-10-26T00:00:00.000Z' });
    expect(Object.keys(files)).toEqual(['knowledge/positioning.md', 'knowledge/voice.md']);
    const nested = renderBrain(PROFILE, { slug: 'Example Pay' });
    expect(Object.keys(nested)[0]).toBe('knowledge/example-pay/positioning.md');
    expect(brainPath('objections', 'x')).toBe('knowledge/x/objections.md');
  });

  test('positioning carries the frontmatter and sections', () => {
    const text = renderBrain(PROFILE, { exportedAt: '2026-10-26T00:00:00.000Z' })[
      'knowledge/positioning.md'
    ]!;
    const { data } = parseFrontmatter(text);
    expect(data).toEqual({
      product: 'ExamplePay: payouts',
      url: 'https://examplepay.dev',
      category: 'developer payments',
      source: 'outreachgraph',
      offering_id: 'off_1',
      exported_at: '2026-10-26T00:00:00.000Z',
    });
    expect(text).toContain('## Value propositions\n\n- Settles in 24 hours');
    expect(text).toContain('## Problems it solves\n\n- Wires take a week');
    expect(text).toContain('## Competitors\n\n- Stripe Connect\n- Wise');
  });

  test('positioning and voice round-trip', () => {
    const parsed = parseBrainFiles(renderBrain(PROFILE));
    const { offeringId: _id, ...product } = PROFILE.product;
    expect(parsed.product).toEqual(product);
    const { name: _name, ...voice } = PROFILE.voice!;
    expect(parsed.voice).toEqual(voice);
  });

  test('empty sections round-trip as empty, not as placeholder text', () => {
    const files = renderBrain({
      product: {
        name: 'Bare',
        category: 'tools',
        valuePropositions: [],
        likelyPains: [],
        competitors: [],
      },
      voice: { style: 'plain', samples: [], prohibitedClaims: [] },
    });
    const parsed = parseBrainFiles(files);
    expect(parsed.product?.valuePropositions).toEqual([]);
    expect(parsed.product?.description).toBeNull();
    expect(parsed.voice?.samples).toEqual([]);
    expect(parsed.voice?.instructions).toBeNull();
  });

  test('audience and objections render; neither is imported', () => {
    const files = renderBrain(PROFILE, {
      audience: mergeAudiences([
        { titles: ['CTO', 'VP Eng'], countries: ['US'] },
        { titles: ['cto', 'Founder'], exclusions: [] },
      ]),
      objections: summariseObjections([
        {
          label: 'question',
          reason: 'asks about pricing',
          body: 'Hi Anthony,\nWhat does it cost per payout? Call me at +1 (415) 555-0100.',
          occurredAt: '2026-10-01T00:00:00Z',
        },
      ]),
    });
    const audience = files['knowledge/audience.md']!;
    expect(audience).toContain('## Titles\n\n- CTO\n- VP Eng\n- Founder');
    expect(audience).toContain('## Countries\n\n- US');
    expect(audience).not.toContain('## Exclusions');
    const objections = files['knowledge/objections.md']!;
    expect(objections).toContain('## Questions (1)');
    expect(objections).toContain('- **asks about pricing**: "What does it cost per payout?"');
    expect(Object.keys(parseBrainFiles(files))).toEqual(['product', 'voice']);
  });
});

describe('parseBrainFiles', () => {
  test('finds the only product directory when no slug is given', () => {
    const files = renderBrain(PROFILE, { slug: 'pay' });
    expect(parseBrainFiles(files).product?.name).toBe('ExamplePay: payouts');
    expect(parseBrainFiles(files, { slug: 'other' })).toEqual({});
  });

  test('only touches what the files contain', () => {
    const parsed = parseBrainFiles({
      'knowledge/positioning.md': '# Renamed\n\n## Competitors\n\n- Acme\n',
    });
    expect(parsed.product).toEqual({ name: 'Renamed', competitors: ['Acme'] });
    expect(parsed.voice).toBeUndefined();
  });

  test('samples may be written as subsections', () => {
    expect(parseSamples('### Sample 1\n\nOne.\n\n### Sample 2\n\nTwo\nlines.')).toEqual([
      'One.',
      'Two\nlines.',
    ]);
  });
});

describe('objections', () => {
  test('excerpts drop greetings, quoted threads, names, emails, links and numbers', () => {
    const excerpt = replyExcerpt(
      'Hey Anthony - we already use Wise at Globex, see globex.com or mail jane@globex.com. Thanks\n\nOn Mon, Anthony wrote:\n> pitch',
      ['Jane Smith', 'Globex', 'Anthony'],
    );
    expect(excerpt).toBe('we already use Wise at [name], see [link] or mail [email].');
  });

  test('caps the excerpt at 160 characters', () => {
    const long = `${'word '.repeat(80)}end.`;
    expect(replyExcerpt(long).length).toBeLessThanOrEqual(160);
  });

  test('groups by label with counts, window and duplicates folded', () => {
    const summary = summariseObjections([
      {
        label: 'not_interested',
        reason: 'has a vendor',
        body: 'We have one.',
        occurredAt: '2026-09-02',
      },
      {
        label: 'not_interested',
        reason: 'has a vendor',
        body: 'We have one.',
        occurredAt: '2026-09-01',
      },
      {
        label: 'referral',
        reason: 'points to Jane',
        body: 'Ask Jane.',
        occurredAt: '2026-09-05',
        names: ['Jane'],
      },
      { label: 'interested', reason: 'wants a call', body: 'Yes.', occurredAt: '2026-09-09' },
    ]);
    expect(summary.replies).toBe(3);
    expect(summary.from).toBe('2026-09-01');
    expect(summary.to).toBe('2026-09-05');
    expect(summary.groups.map((g) => [g.label, g.count, g.items.length])).toEqual([
      ['not_interested', 2, 1],
      ['referral', 1, 1],
    ]);
    expect(summary.groups[1]!.items[0]).toEqual({
      reason: 'points to [name]',
      excerpt: 'Ask [name].',
    });
  });
});

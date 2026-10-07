import { describe, expect, test } from 'bun:test';
import { competitorMatches, detectTechnologies } from './technologies';

const HTML = `<html><head>
  <script src="https://js.hs-scripts.com/123.js"></script>
  <script src="https://widget.intercom.io/widget/abc"></script>
  <link rel="stylesheet" href="https://acme.com/wp-content/themes/x/style.css">
</head><body><script src="https://js.stripe.com/v3/"></script></body></html>`;

describe('detectTechnologies', () => {
  test('names each tool on a marker specific to it, with the marker', () => {
    const found = detectTechnologies(HTML);
    expect(found.map((tech) => tech.name).sort()).toEqual(
      ['HubSpot', 'Intercom', 'Stripe', 'WordPress'].sort(),
    );
    expect(found.find((tech) => tech.name === 'Intercom')?.evidence).toBe('widget.intercom.io');
  });

  test('a page with no markers names nothing', () => {
    expect(detectTechnologies('<html><body>Hello</body></html>')).toEqual([]);
  });
});

describe('competitorMatches', () => {
  test('matches the product’s competitors by name, case-insensitively', () => {
    const found = detectTechnologies(HTML);
    expect(competitorMatches(found, ['intercom', 'Zendesk']).map((t) => t.name)).toEqual([
      'Intercom',
    ]);
    expect(competitorMatches(found, [])).toEqual([]);
  });
});

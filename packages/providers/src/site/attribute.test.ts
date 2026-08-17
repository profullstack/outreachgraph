/**
 * Attribution tests.
 *
 * The interesting cases are all about *not* attributing: the company's own
 * account sitting in the footer under the last person's card, a share button
 * repeated beside every name, two people listed close enough that the markup
 * cannot separate them. Getting those wrong means writing to a named human at
 * an account that is not theirs, which is worse than not finding it.
 */

import { describe, expect, test } from 'bun:test';
import { attributeToPeople, nameHits } from './attribute';
import { handleFromUrl } from './extract';

const attribute = (html: string, people: readonly string[]) =>
  attributeToPeople({ html, people, handleOf: handleFromUrl });

/** A team page of the shape almost every small company ships. */
const TEAM = `
<html><body>
  <nav><a href="https://x.com/acmecorp">Follow us</a></nav>
  <main>
    <div class="member">
      <h3>Jane Okafor</h3><p>CTO</p>
      <a href="https://x.com/janeokafor">X</a>
      <a href="https://www.linkedin.com/in/jane-okafor">LinkedIn</a>
      <a href="mailto:j.okafor@acme.com">Email</a>
    </div>
    <div class="member">
      <h3>Tom Reilly</h3><p>Head of Sales</p>
      <a href="https://bsky.app/profile/tomsells.bsky.social">Bluesky</a>
      <a href="mailto:tom@acme.com">Email</a>
    </div>
  </main>
  <footer>
    <a href="https://www.linkedin.com/company/acme">Acme on LinkedIn</a>
    <a href="mailto:info@acme.com">Contact</a>
  </footer>
</body></html>`;

describe('nameHits', () => {
  test('locates each person once', () => {
    const hits = nameHits(TEAM, ['Jane Okafor', 'Tom Reilly']);

    expect(hits).toHaveLength(2);
    expect(hits[0]?.name).toBe('Jane Okafor');
    expect(hits[1]?.name).toBe('Tom Reilly');
  });

  test('finds a name split across markup', () => {
    // `<span>Jane</span> <span>Okafor</span>` is ordinary, and a literal search
    // misses it — losing the block, and with it every link inside the card.
    const html = '<h3><span>Jane</span>&nbsp;<b>Okafor</b></h3>';
    expect(nameHits(html, ['Jane Okafor'])).toHaveLength(1);
  });

  test('reports nothing for a person the page does not name', () => {
    expect(nameHits(TEAM, ['Nobody Here'])).toHaveLength(0);
  });

  test('does not treat a handle as another mention of the name', () => {
    // `x.com/janeokafor` reads as "Jane" immediately followed by "Okafor". When
    // the separator between name parts was optional this matched, cutting the
    // card in two at the very link it was meant to collect.
    const html = '<h3>Jane Okafor</h3><a href="https://x.com/janeokafor">X</a>';

    expect(nameHits(html, ['Jane Okafor'])).toHaveLength(1);
    expect(attribute(html, ['Jane Okafor']).identitiesByPerson.get('Jane Okafor')).toHaveLength(1);
  });

  test('does not match a name inside a longer one', () => {
    expect(nameHits('<h3>Mary Jane Okafor-Smith</h3>', ['Jane Okafor'])).toHaveLength(0);
  });
});

describe('attributeToPeople', () => {
  test('gives each person the handles inside their own card', () => {
    const result = attribute(TEAM, ['Jane Okafor', 'Tom Reilly']);

    const jane = result.identitiesByPerson.get('Jane Okafor') ?? [];
    expect(jane.map((identity) => identity.network).sort()).toEqual(['linkedin', 'x']);
    expect(jane.find((identity) => identity.network === 'x')?.handle).toBe('janeokafor');

    const tom = result.identitiesByPerson.get('Tom Reilly') ?? [];
    expect(tom.map((identity) => identity.network)).toEqual(['bluesky']);
  });

  test('leaves the company’s own accounts with the company', () => {
    const result = attribute(TEAM, ['Jane Okafor', 'Tom Reilly']);

    // The nav and footer links belong to nobody, and the footer one sits right
    // after Tom's card — exactly where a naive "nearest name" rule would hand
    // Acme's corporate LinkedIn to Tom.
    const company = result.companyIdentities.map((identity) => identity.handle);
    expect(company).toContain('acmecorp');
    expect(company).toContain('acme');

    const tom = result.identitiesByPerson.get('Tom Reilly') ?? [];
    expect(tom.map((identity) => identity.handle)).not.toContain('acme');
  });

  test('refuses a handle that appears under more than one person', () => {
    // A share button repeated beside every name. One handle cannot be two
    // people, so it is the company's.
    const html = `
      <h3>Jane Okafor</h3><a href="https://x.com/acmecorp">Share</a>
      <h3>Tom Reilly</h3><a href="https://x.com/acmecorp">Share</a>`;

    const result = attribute(html, ['Jane Okafor', 'Tom Reilly']);

    expect(result.identitiesByPerson.size).toBe(0);
    expect(result.companyIdentities.map((i) => i.handle)).toEqual(['acmecorp']);
  });

  test('refuses a handle that also appears outside every card', () => {
    // Inside Jane's card *and* in the footer: the footer copy proves it is not
    // hers, whatever the card placement suggests.
    const html = `
      <h3>Jane Okafor</h3><a href="https://x.com/acmecorp">X</a>
      <footer><a href="https://x.com/acmecorp">X</a></footer>`;

    const result = attribute(html, ['Jane Okafor']);

    expect(result.identitiesByPerson.size).toBe(0);
    expect(result.companyIdentities).toHaveLength(1);
  });

  test('scores a handle that matches the name higher than one that does not', () => {
    const html = `
      <h3>Jane Okafor</h3><a href="https://x.com/janeokafor">X</a>
      <h3>Tom Reilly</h3><a href="https://x.com/sellsdaily">X</a>`;

    const result = attribute(html, ['Jane Okafor', 'Tom Reilly']);

    const jane = result.identitiesByPerson.get('Jane Okafor')?.[0];
    const tom = result.identitiesByPerson.get('Tom Reilly')?.[0];

    expect(jane?.providerConfidence).toBeGreaterThan(tom?.providerConfidence ?? 1);
    // Both must clear the outreach floor, or discovering a handle would make
    // the person unreachable — `identity_confidence` is the *minimum* across
    // their identities.
    expect(tom?.providerConfidence).toBeGreaterThanOrEqual(0.85);
  });

  test('keeps a distant link away from the only person on the page', () => {
    // Without the block cap, the final person's block runs to the end of the
    // document and collects everything below it.
    const html = `<h3>Jane Okafor</h3><p>CTO</p>${'<p>filler</p>'.repeat(400)}
      <footer><a href="https://x.com/acmecorp">X</a></footer>`;

    const result = attribute(html, ['Jane Okafor']);

    expect(result.identitiesByPerson.size).toBe(0);
    expect(result.companyIdentities.map((i) => i.handle)).toEqual(['acmecorp']);
  });

  describe('personal addresses', () => {
    test('claims an address inside a person’s own card', () => {
      // `j.okafor@` does not match "Jane Okafor" by the name rule, which is
      // exactly why production had zero personal addresses. Its placement says
      // whose it is.
      const result = attribute(TEAM, ['Jane Okafor', 'Tom Reilly']);

      expect(result.emailsByPerson.get('Jane Okafor')).toBe('j.okafor@acme.com');
      expect(result.emailsByPerson.get('Tom Reilly')).toBe('tom@acme.com');
    });

    test('never claims a role address for a person', () => {
      // Nobody named Jane reads `info@`, and greeting a shared inbox by name is
      // worse than not writing at all.
      const html = `<h3>Jane Okafor</h3><a href="mailto:info@acme.com">Contact</a>`;
      expect(attribute(html, ['Jane Okafor']).emailsByPerson.size).toBe(0);
    });

    test('refuses an address that appears under two people', () => {
      const html = `
        <h3>Jane Okafor</h3><a href="mailto:hello@acme.com">Mail</a>
        <h3>Tom Reilly</h3><a href="mailto:hello@acme.com">Mail</a>`;

      expect(attribute(html, ['Jane Okafor', 'Tom Reilly']).emailsByPerson.size).toBe(0);
    });
  });

  test('does not leave a person’s account listed as the company’s', () => {
    // The extractor files every link against the company before anyone knows
    // whose is whose. If it keeps them afterwards, the principal's personal X
    // account is also the practice's, and "post as the company" posts as her.
    const result = attribute(TEAM, ['Jane Okafor', 'Tom Reilly']);
    const company = result.companyIdentities.map((i) => `${i.network}:${i.handle}`);

    expect(company).not.toContain('x:janeokafor');
    expect(company).not.toContain('bluesky:tomsells.bsky.social');
  });

  test('attributes nothing when the page names nobody', () => {
    const result = attribute(TEAM, []);

    expect(result.identitiesByPerson.size).toBe(0);
    expect(result.emailsByPerson.size).toBe(0);
    // Everything the page published is still kept, just not as anyone's.
    expect(result.companyIdentities.length).toBeGreaterThan(0);
  });
});

describe('Fediverse accounts', () => {
  const FEDI_TEAM = `
    <main>
      <div class="member">
        <h3>Julia Evans</h3><p>Writer</p>
        <a href="https://defcon.social/@b0rk@jvns.ca">Mastodon</a>
      </div>
      <div class="member">
        <h3>Wes Todd</h3><p>Platform</p>
        <a href="https://hachyderm.io/@wes">Mastodon</a>
      </div>
    </main>
  `;

  test('a remote view resolves to the server that owns the account', () => {
    const julia = attribute(FEDI_TEAM, ['Julia Evans', 'Wes Todd']).identitiesByPerson.get(
      'Julia Evans',
    );
    const mastodon = julia?.find((identity) => identity.network === 'mastodon');

    // defcon.social was only rendering it; jvns.ca is where a reply has to go.
    expect(mastodon?.handle).toBe('b0rk@jvns.ca');
    expect(mastodon?.profileUrl).toBe('https://jvns.ca/@b0rk');
  });

  test('each account goes to the person whose card it sits in', () => {
    const wes = attribute(FEDI_TEAM, ['Julia Evans', 'Wes Todd']).identitiesByPerson.get(
      'Wes Todd',
    );

    expect(wes?.map((identity) => identity.handle)).toEqual(['wes@hachyderm.io']);
  });

  test('a /@name link on a host that is not a Fediverse server is not one', () => {
    const html = `<main><div><h3>Julia Evans</h3>
      <a href="https://medium.com/@b0rk">Blog</a></div></main>`;

    const julia = attribute(html, ['Julia Evans']).identitiesByPerson.get('Julia Evans') ?? [];

    expect(julia.some((identity) => identity.network === 'mastodon')).toBe(false);
  });
});

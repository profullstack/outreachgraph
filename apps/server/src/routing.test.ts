import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { PUBLIC_MAIL_PREFIXES, routesToApi } from './routing';
import { trackedLinkUrl, openPixelUrl } from '@outreachgraph/domain';
import { unsubscribeUrl } from '@outreachgraph/pipeline';

describe('routesToApi', () => {
  test('sends the API and health checks to the API', () => {
    expect(routesToApi('/api/v1/people')).toBe(true);
    expect(routesToApi('/health/ready')).toBe(true);
  });

  test('sends every link printed into a message to the API', () => {
    // Built with the same helpers the senders use, so a path that changes in
    // one place and not the other fails here rather than in someone's inbox.
    for (const url of [
      trackedLinkUrl('https://app.test', 'tlk_x'),
      unsubscribeUrl('https://app.test', 'uns_x'),
      openPixelUrl('https://app.test', 'opx_x'),
    ]) {
      expect(routesToApi(new URL(url).pathname)).toBe(true);
    }
  });

  test('leaves pages to the web app', () => {
    expect(routesToApi('/')).toBe(false);
    expect(routesToApi('/approvals')).toBe(false);
    expect(routesToApi('/terms')).toBe(false);
    expect(routesToApi('/u')).toBe(false);
  });

  test('no web page claims a public mail prefix', () => {
    for (const prefix of PUBLIC_MAIL_PREFIXES) {
      const segment = prefix.replaceAll('/', '');
      expect(existsSync(new URL(`../../web/app/${segment}`, import.meta.url))).toBe(false);
      expect(existsSync(new URL(`../../web/app/(app)/${segment}`, import.meta.url))).toBe(false);
    }
  });
});

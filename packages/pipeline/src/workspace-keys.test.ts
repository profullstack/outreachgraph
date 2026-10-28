import { describe, expect, test } from 'bun:test';

import {
  encryptSecret,
  generateSecretKey,
  parseSecretKey,
  openPrivateKeySync,
  openSealedSync,
} from '@outreachgraph/secrets';
import { makeTestSeal } from '@outreachgraph/secrets/testing';

import { resealRow } from './workspace-keys';

describe('migration off SECRET_ENCRYPTION_KEY', () => {
  test('re-seals v1 values to the workspace key and skips v2', () => {
    const key = parseSecretKey(generateSecretKey());
    const { seal, dek } = makeTestSeal('ws_1');
    const row = { access_token_enc: encryptSecret('smtp-pw', key), refresh_token_enc: null };
    const { patch, failed } = resealRow(row, 'ws_1', seal.public_key, (v) => {
      const { decryptSecret } =
        require('@outreachgraph/secrets') as typeof import('@outreachgraph/secrets');
      return decryptSecret(v, key);
    });
    expect(failed).toBe(0);
    const priv = openPrivateKeySync(dek, seal, 'ws_1');
    expect(openSealedSync(priv, patch!.access_token_enc!, 'ws_1', 'access_token_enc')).toBe(
      'smtp-pw',
    );
    expect(
      resealRow(
        { access_token_enc: patch!.access_token_enc!, refresh_token_enc: null },
        'ws_1',
        seal.public_key,
        () => 'x',
      ).patch,
    ).toBeNull();
  });

  test('migration off leaves v1 values in place; a corrupt value is counted, not lost', () => {
    const { seal } = makeTestSeal('ws_1');
    expect(
      resealRow(
        { access_token_enc: 'v1.a.b.c', refresh_token_enc: null },
        'ws_1',
        seal.public_key,
        null,
      ).patch,
    ).toBeNull();
    const r = resealRow(
      { access_token_enc: 'v1.a.b.c', refresh_token_enc: null },
      'ws_1',
      seal.public_key,
      () => {
        throw new Error('bad');
      },
    );
    expect(r.patch).toBeNull();
    expect(r.failed).toBe(1);
  });
});

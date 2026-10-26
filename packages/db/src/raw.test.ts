import { describe, expect, test } from 'bun:test';
import { pgConnection } from './raw';

describe('pgConnection', () => {
  test('sslmode=require encrypts without verifying, as the main client does', () => {
    const c = pgConnection('postgres://u:p@db.example:5432/app?sslmode=require');
    expect(c.ssl).toEqual({ rejectUnauthorized: false });
    expect(c.connectionString).not.toContain('sslmode');
  });

  test('verify-full verifies; no sslmode leaves ssl unset', () => {
    expect(pgConnection('postgres://u:p@h/app?sslmode=verify-full').ssl).toBe(true);
    expect(pgConnection('postgres://u:p@h/app').ssl).toBeUndefined();
  });
});

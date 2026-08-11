#!/usr/bin/env bun
/**
 * Migration CLI.
 *
 *   bun run db:migrate            apply pending migrations
 *   bun run db:status             show what is applied
 *   bun run db:reset              drop the local file and re-apply
 *
 * `--reset` refuses to touch anything but a local file database, so it cannot
 * be pointed at staging or production by accident.
 */

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createDatabase, resolveConfig } from '../client';
import { migrate, migrationStatus } from '../migrate';

const MIGRATIONS_DIR = join(import.meta.dir, '../../../../migrations');

async function main(): Promise<number> {
  const args = new Set(process.argv.slice(2));
  const config = resolveConfig();

  if (args.has('--reset')) {
    if (!config.url.startsWith('file:')) {
      console.error(`refusing to reset a non-file database: ${config.url}`);
      return 1;
    }
    const path = config.url.slice('file:'.length);
    await rm(path, { force: true });
    await rm(`${path}-wal`, { force: true });
    await rm(`${path}-shm`, { force: true });
    console.log(`removed ${path}`);
  }

  const client = createDatabase();

  try {
    if (args.has('--status')) {
      const status = await migrationStatus(client, MIGRATIONS_DIR);
      for (const entry of status) {
        const mark = entry.applied ? '✓' : ' ';
        const when = entry.appliedAt ?? 'pending';
        console.log(`${mark} ${entry.name.padEnd(36)} ${when}`);
      }
      const pending = status.filter((s) => !s.applied).length;
      console.log(`\n${status.length - pending} applied, ${pending} pending`);
      return 0;
    }

    const result = await migrate(client, MIGRATIONS_DIR);
    for (const name of result.applied) console.log(`applied ${name}`);
    if (result.applied.length === 0) {
      console.log(`up to date (${result.skipped.length} migrations)`);
    } else {
      console.log(`\napplied ${result.applied.length} migration(s) to ${config.url}`);
    }
    return 0;
  } finally {
    client.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });

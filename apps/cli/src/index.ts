#!/usr/bin/env bun
/**
 * `og` — OutreachGraph from a terminal.
 *
 * A client of `/api/v1` and nothing else, for the same reason the MCP server
 * is: the policy engine runs server-side, and a surface that could reach past
 * it would be a surface where the gates are optional.
 *
 * The launch wedge is developer tooling founders, who are already in a
 * terminal. This is the cheapest surface in the product to build and the one
 * most likely to be used daily by exactly the people it sells to.
 */

import { ApiError, configFromEnv, createClient } from '@outreachgraph/mcp/src/client';
import { commandByName, usage } from './commands';

export interface ParsedArgv {
  readonly command: string | undefined;
  readonly args: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean | string[]>>;
}

/**
 * Splits argv into a command, positional arguments and flags.
 *
 * A repeated flag collects into a list rather than overwriting, because
 * `--ask a --ask b` is how a shell expresses a list without inventing a
 * delimiter that will eventually appear inside one of the values.
 */
export function parseArgv(argv: readonly string[]): ParsedArgv {
  const args: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;

    if (!token.startsWith('--')) {
      args.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    const value = next && !next.startsWith('--') ? ((index += 1), next) : true;

    const existing = flags[key];
    if (existing === undefined) {
      flags[key] = value;
    } else if (Array.isArray(existing)) {
      if (typeof value === 'string') existing.push(value);
    } else if (typeof existing === 'string' && typeof value === 'string') {
      flags[key] = [existing, value];
    }
  }

  return { command: args[0], args: args.slice(1), flags };
}

export async function run(argv: readonly string[]): Promise<{ output: string; code: number }> {
  const { command, args, flags } = parseArgv(argv);

  if (!command || command === 'help' || flags.help === true) {
    return { output: usage(), code: 0 };
  }

  const found = commandByName(command);
  if (!found) {
    return { output: `Unknown command: ${command}\n\n${usage()}`, code: 1 };
  }

  try {
    const client = createClient(configFromEnv());
    const output = await found.run({ client, args, flags: flags as never });
    return { output, code: 0 };
  } catch (error) {
    return { output: explain(error), code: 1 };
  }
}

/**
 * A failure a person can act on.
 *
 * A policy refusal is not an error in the usual sense and is not presented as
 * one: it is the product working, and the useful response is a different
 * action rather than a retry.
 */
export function explain(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'policy_denied') {
      return [
        `Refused: ${error.message}`,
        '',
        'That is the policy engine, not a transient failure — the same call will be',
        'refused again. If this is a network we may not automate, get a prefilled',
        'composer instead:  og post <recommendationId> --network <network>',
      ].join('\n');
    }

    if (error.status === 401 || error.status === 403) {
      return `Not permitted: ${error.message}\nCheck OUTREACHGRAPH_API_TOKEN and the workspace it is scoped to.`;
    }

    return `${error.message}`;
  }

  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
  const result = await run(process.argv.slice(2));
  // Output on stdout, failures on stderr, so `og prospects | head` behaves and
  // an error in a pipeline is still visible.
  if (result.code === 0) console.log(result.output);
  else console.error(result.output);
  process.exit(result.code);
}

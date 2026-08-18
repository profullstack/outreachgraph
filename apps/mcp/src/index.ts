#!/usr/bin/env bun
/**
 * OutreachGraph as an MCP server.
 *
 * The pitch in one sentence: this is a go-to-market tool an agent can drive
 * that **cannot be talked into breaking a platform's terms**, because the
 * refusal is a pure function on the server rather than an instruction in a
 * prompt.
 *
 * Everything here is a thin translation layer over `/api/v1`. That is
 * deliberate and load-bearing — see `tools.ts` — so this file's only jobs are
 * to speak the protocol, hand a caller's arguments to a tool, and turn an API
 * error into something an agent can act on rather than retry blindly.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ApiError, configFromEnv, createClient, type ApiClient } from './client';
import { runTool, TOOLS, toolByName } from './tools';

export function createServer(client: ApiClient): Server {
  const server = new Server(
    { name: 'outreachgraph', version: '0.3.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: {
        readOnlyHint: tool.readOnly,
        // Nothing here destroys data. `suppress` is the closest, and it adds a
        // tombstone rather than removing anything.
        destructiveHint: false,
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = toolByName(request.params.name);
    if (!tool) {
      return errorResult(`No such tool: ${request.params.name}`);
    }

    try {
      const result = await runTool(tool, client, request.params.arguments ?? {});
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return errorResult(describe(error));
    }
  });

  return server;
}

/**
 * Turns a failure into something an agent can act on.
 *
 * A policy refusal is the interesting case and is deliberately not dressed up
 * as a transient error. It names the gate and says the decision is final, so a
 * caller retries something *different* rather than the same call again — which
 * is what a vague "request failed" reliably produces.
 */
export function describe(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'policy_denied') {
      return [
        `Refused by the policy engine: ${error.message}`,
        '',
        'This is a deterministic decision, not a rate limit and not a transient failure.',
        'Retrying the same call will produce the same answer.',
        'If the network is one the product may not automate, use share_link to get a',
        'prefilled composer a person can post themselves.',
        error.details ? `Details: ${JSON.stringify(error.details)}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    }

    if (error.status === 401 || error.status === 403) {
      return `Not permitted: ${error.message}. Check the token and workspace this server is configured with.`;
    }

    return `${error.code}: ${error.message}`;
  }

  return error instanceof Error ? error.message : String(error);
}

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

async function main(): Promise<void> {
  const client = createClient(configFromEnv());
  const server = createServer(client);
  await server.connect(new StdioServerTransport());
}

// `import.meta.main` is false when this module is imported by a test, which is
// what keeps the server from trying to speak MCP down a test runner's stdout.
if (import.meta.main) {
  main().catch((error: unknown) => {
    // stderr, never stdout: stdout is the protocol channel and a stray line
    // there corrupts the session rather than reporting the problem.
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

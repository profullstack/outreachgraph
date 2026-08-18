/**
 * The HTTP client both machine surfaces use.
 *
 * Neither the MCP server nor the CLI talks to the database. They are clients of
 * `/api/v1` and nothing else, which is the whole reason the safety claim below
 * holds: the policy engine runs server-side, on the same code path a browser
 * uses, and a client cannot route around it because a client has no other
 * route.
 *
 * That is worth being explicit about, because the obvious "faster" design —
 * give the MCP server a database handle — would quietly move every gate into
 * a process an LLM is driving.
 */

export interface ApiConfig {
  readonly baseUrl: string;
  readonly token: string;
  readonly workspaceId: string;
  readonly organizationId: string;
  readonly userId?: string | undefined;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface ApiClient {
  get(path: string, query?: Record<string, string | undefined>): Promise<unknown>;
  post(path: string, body?: unknown): Promise<unknown>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Reads configuration from the environment.
 *
 * Throws rather than defaulting, and names every missing variable at once. A
 * machine surface that starts with half its configuration fails later, on a
 * call, where the error reaches an agent instead of the person who set it up.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const missing: string[] = [];

  const baseUrl = env.OUTREACHGRAPH_API_URL ?? env.API_URL;
  const token = env.OUTREACHGRAPH_API_TOKEN ?? env.API_TOKEN;
  const workspaceId = env.OUTREACHGRAPH_WORKSPACE_ID;
  const organizationId = env.OUTREACHGRAPH_ORGANIZATION_ID;

  if (!baseUrl) missing.push('OUTREACHGRAPH_API_URL');
  if (!token) missing.push('OUTREACHGRAPH_API_TOKEN');
  if (!workspaceId) missing.push('OUTREACHGRAPH_WORKSPACE_ID');
  if (!organizationId) missing.push('OUTREACHGRAPH_ORGANIZATION_ID');

  if (missing.length > 0) {
    throw new Error(`Missing configuration: ${missing.join(', ')}`);
  }

  return {
    baseUrl: baseUrl!.replace(/\/+$/, ''),
    token: token!,
    workspaceId: workspaceId!,
    organizationId: organizationId!,
    ...(env.OUTREACHGRAPH_USER_ID ? { userId: env.OUTREACHGRAPH_USER_ID } : {}),
  };
}

export function createClient(config: ApiConfig, fetchImpl: FetchLike = fetch): ApiClient {
  const headers = {
    authorization: `Bearer ${config.token}`,
    'x-workspace-id': config.workspaceId,
    'x-organization-id': config.organizationId,
    ...(config.userId ? { 'x-user-id': config.userId } : {}),
  };

  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const response = await fetchImpl(`${config.baseUrl}/api/v1${path}`, {
      method,
      headers: {
        ...headers,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const text = await response.text();
    const parsed: unknown = text ? safeJson(text) : {};

    if (!response.ok) {
      const error = (parsed as { error?: { code?: string; message?: string; details?: unknown } })
        .error;
      throw new ApiError(
        response.status,
        error?.code ?? 'http_error',
        error?.message ?? `${method} ${path} failed with ${response.status}`,
        error?.details,
      );
    }

    return parsed;
  };

  return {
    get: (path, query) => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query ?? {})) {
        if (value !== undefined) params.set(key, value);
      }
      const suffix = params.toString();
      return call('GET', suffix ? `${path}?${suffix}` : path);
    },
    post: (path, body) => call('POST', path, body),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

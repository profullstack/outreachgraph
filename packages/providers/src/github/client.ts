/**
 * Thin GitHub REST client (PRD §16.6, §51).
 *
 * GitHub is a signal source, not a messaging channel. This client therefore
 * only ever reads public data: profiles, repositories and public events.
 *
 * `fetchImpl` is injectable so tests exercise the real parsing and error
 * handling against recorded payloads instead of the network.
 */

export const GITHUB_API = 'https://api.github.com';

export interface GitHubUser {
  login: string;
  id: number;
  name: string | null;
  company: string | null;
  blog: string | null;
  location: string | null;
  email: string | null;
  bio: string | null;
  twitter_username: string | null;
  public_repos: number;
  followers: number;
  html_url: string;
  created_at: string;
  updated_at: string;
}

export interface GitHubRepo {
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  language: string | null;
  topics?: string[];
  fork: boolean;
  stargazers_count: number;
  created_at: string;
  pushed_at: string | null;
}

export interface GitHubEvent {
  id: string;
  type: string | null;
  created_at: string;
  repo?: { id: number; name: string; url: string };
  payload?: Record<string, unknown>;
}

export interface GitHubClientOptions {
  /** Raises the rate limit from 60/hr to 5000/hr. Never sent to a model. */
  readonly token?: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly userAgent?: string;
}

/**
 * Raised when GitHub refuses the request for quota reasons.
 *
 * Kept distinct from a generic failure because the waterfall should stop
 * asking GitHub entirely until the reset, rather than retrying per prospect.
 */
export class GitHubRateLimitError extends Error {
  readonly resetAt?: Date;

  constructor(resetAt?: Date) {
    super(
      resetAt
        ? `GitHub rate limit exhausted; resets at ${resetAt.toISOString()}`
        : 'GitHub rate limit exhausted',
    );
    this.name = 'GitHubRateLimitError';
    this.resetAt = resetAt;
  }
}

export class GitHubNotFoundError extends Error {
  constructor(path: string) {
    super(`GitHub returned 404 for ${path}`);
    this.name = 'GitHubNotFoundError';
  }
}

export class GitHubClient {
  readonly #options: GitHubClientOptions;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;

  constructor(options: GitHubClientOptions = {}) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#baseUrl = (options.baseUrl ?? GITHUB_API).replace(/\/$/, '');
  }

  async getUser(login: string): Promise<GitHubUser> {
    return this.#request<GitHubUser>(`/users/${encodeURIComponent(login)}`);
  }

  async getRepos(login: string, limit = 20): Promise<GitHubRepo[]> {
    return this.#request<GitHubRepo[]>(
      `/users/${encodeURIComponent(login)}/repos?sort=pushed&per_page=${limit}`,
    );
  }

  /** Public events only. GitHub caps this at roughly the last 90 days. */
  async getPublicEvents(login: string, limit = 50): Promise<GitHubEvent[]> {
    return this.#request<GitHubEvent[]>(
      `/users/${encodeURIComponent(login)}/events/public?per_page=${limit}`,
    );
  }

  async searchUsers(query: string, limit = 20): Promise<{ items: { login: string }[] }> {
    return this.#request<{ items: { login: string }[] }>(
      `/search/users?q=${encodeURIComponent(query)}&per_page=${limit}`,
    );
  }

  async #request<T>(path: string): Promise<T> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': this.#options.userAgent ?? 'OutreachGraph',
    };
    if (this.#options.token) headers.authorization = `Bearer ${this.#options.token}`;

    const response = await this.#fetch(`${this.#baseUrl}${path}`, { headers });

    if (response.status === 404) throw new GitHubNotFoundError(path);

    // GitHub signals quota exhaustion as 403 with remaining 0, or as 429.
    if (response.status === 429 || (response.status === 403 && isQuotaExhausted(response))) {
      throw new GitHubRateLimitError(resetAt(response));
    }

    if (!response.ok) {
      throw new Error(`GitHub ${response.status} for ${path}`);
    }

    return (await response.json()) as T;
  }
}

function isQuotaExhausted(response: Response): boolean {
  return response.headers.get('x-ratelimit-remaining') === '0';
}

function resetAt(response: Response): Date | undefined {
  const header = response.headers.get('x-ratelimit-reset');
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? new Date(seconds * 1000) : undefined;
}

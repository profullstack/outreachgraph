/**
 * Throttles for the endpoints a bot can turn into a bill or a spam cannon.
 *
 * Two kinds of drain. The public auth routes send email to whatever address
 * they are handed (b1dz.com was driven by a Tor-rotating script into mailing
 * ~130 strangers through exactly these two forms), and the job-post routes
 * spend ValueSERP credits per call. Both are throttled with
 * `@profullstack/form-guard`'s sliding window, the house module for this,
 * where a refused attempt still counts: a caller that keeps hammering keeps its
 * own window full.
 *
 * A refusal is a 429 with `Retry-After`, never a silent success, because the
 * 4xx in nginx's log is what lets ThreatCrush ban the address that keeps
 * earning them.
 *
 * Memory store, per process: the deployment is one container (see CLAUDE.md,
 * migrations at boot), and a deploy resetting the windows is acceptable for
 * blunting floods rather than accounting for them.
 */

import { createRateLimiter } from '@profullstack/form-guard';
import { ApiError } from './context';

export interface ThrottleLimit {
  readonly max: number;
  readonly windowMs: number;
}

const HOUR = 3_600_000;

/** Per-key limits. Generous for a person, useless for a script. */
export const DEFAULT_THROTTLES = {
  /** Per IP. Each one creates an account and sends a verification mail. */
  register: { max: 5, windowMs: HOUR },
  /** Per IP. Each one may mail a reset link to someone. */
  forgotByIp: { max: 5, windowMs: HOUR },
  /** Per target address: a bot rotating IPs still cannot keep mailing one stranger. */
  forgotByEmail: { max: 3, windowMs: HOUR },
  /** Per IP, across accounts; the per-account lockout covers one account. */
  login: { max: 30, windowMs: 15 * 60_000 },
  /** Per user. */
  verifyResend: { max: 5, windowMs: HOUR },
  /** Per workspace: four ValueSERP credits a search. */
  jobSearch: { max: 20, windowMs: HOUR },
  /** Per workspace: one or two credits a posting, run inline. */
  jobResolve: { max: 60, windowMs: HOUR },
  /** Per workspace: each request may queue up to a hundred resolves. */
  jobAdd: { max: 30, windowMs: HOUR },
} as const satisfies Record<string, ThrottleLimit>;

export type ThrottleName = keyof typeof DEFAULT_THROTTLES;
export type ThrottleConfig = Partial<Record<ThrottleName, ThrottleLimit>>;

export interface Throttles {
  /**
   * Counts one attempt against `name` for `key`; throws a 429 once over.
   * A missing key is not throttled: see `clientIp`.
   */
  take(name: ThrottleName, key: string | null | undefined): Promise<void>;
}

export function createThrottles(overrides: ThrottleConfig = {}): Throttles {
  const limiters = new Map<ThrottleName, ReturnType<typeof createRateLimiter>>();
  for (const name of Object.keys(DEFAULT_THROTTLES) as ThrottleName[]) {
    limiters.set(name, createRateLimiter(overrides[name] ?? DEFAULT_THROTTLES[name]));
  }

  return {
    async take(name, key) {
      if (!key) return;
      const verdict = await limiters.get(name)!.check(`${name}:${key}`);
      if (verdict.ok) return;
      const seconds = Math.max(1, Math.ceil(verdict.retryAfterMs / 1000));
      throw new ApiError(429, 'rate_limited', `too many requests; try again in ${seconds} s`, {
        retryAfterSeconds: seconds,
      });
    },
  };
}

/**
 * The caller's address, as the edge proxy saw it.
 *
 * `X-Real-IP` first: dev2's nginx sets it to `$remote_addr`, which a client
 * cannot forge. `X-Forwarded-For`'s first hop is whatever the client put
 * there — trusting it is how b1dz's limiter was walked around — so it is only
 * the fallback for an edge that sets nothing else.
 *
 * Null when no proxy header is present at all. The container listens on
 * loopback only, so in production that means a local caller (a test, the
 * PWA's own server-side fetch), which is not who these limits are for.
 */
export function clientIp(request: Request): string | null {
  const real = request.headers.get('x-real-ip')?.trim();
  if (real) return real;
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || null;
}

/**
 * The signature the b1dz bot carried on every request: a User-Agent wrapped in
 * literal quotes (nginx logs it as `"\x22Mozilla…\x22"`). No browser sends one.
 */
export function isQuotedUserAgent(request: Request): boolean {
  const agent = request.headers.get('user-agent')?.trim() ?? '';
  return agent.length > 1 && (agent.startsWith('"') || agent.startsWith("'"));
}

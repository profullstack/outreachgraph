/**
 * "Build it": hand an idea to chovy.com, which builds and ships the app on our
 * own stack. Chovy's campaign endpoint stores the idea and returns a one-time
 * link (valid 7 days) that opens Chovy's intake with the idea already filled in.
 *
 *   POST {CHOVY_URL}/api/campaign/contexts
 *   Authorization: Bearer {CHOVY_CAMPAIGN_SECRET}
 *   { idea, experiment, variant, first_touch: { utm_source, ... } }
 *   -> { id, handoff_url, expires_at }
 */

export interface BuildBrief {
  label: string;
  wants: string[];
  askers: number;
  subs: string[];
  /** Feeds it came up in (Ask HN, newsletters), by name. */
  feeds?: string[];
  /** Revenue its sources quote for products like it. */
  revenue?: string[];
  /** Recent launches that match it. */
  rivals?: number;
  /** A few of the posts that asked, so the builder sees the demand in people's words. */
  examples: Array<{ title: string; url: string }>;
}

/** The idea as Chovy's intake reads it: what to build, what it must do, who asked. */
export function briefText(b: BuildBrief): string {
  const lines = [
    `Build a web app: ${b.label}.`,
    b.wants.length ? `It should: ${b.wants.slice(0, 8).join('; ')}.` : '',
    `${b.askers} ${b.askers === 1 ? 'person or source has' : 'different people and sources have'} asked for this${
      b.subs.length ? ` on Reddit (${b.subs.map((s) => `r/${s}`).join(', ')})` : ''
    }${b.subs.length && b.feeds?.length ? ' and' : ''}${b.feeds?.length ? ` in ${b.feeds.join(', ')}` : ''}.`,
    b.revenue?.length ? `Products like it make money: ${b.revenue.join('; ')}.` : '',
    b.rivals
      ? `${b.rivals} similar launch${b.rivals === 1 ? '' : 'es'} recently: differentiate.`
      : '',
    ...b.examples.slice(0, 3).map((e) => `- "${e.title}" ${e.url}`),
  ];
  return lines.filter(Boolean).join('\n').slice(0, 3900);
}

export interface ChovyConfig {
  url: string;
  secret: string;
}

export function chovyConfig(
  env: Record<string, string | undefined> = process.env,
): ChovyConfig | null {
  const secret = env.CHOVY_CAMPAIGN_SECRET?.trim();
  if (!secret) return null;
  return { url: (env.CHOVY_URL?.trim() || 'https://chovy.com').replace(/\/+$/, ''), secret };
}

export interface Handoff {
  id: number | string;
  handoff_url: string;
  expires_at: number;
}

export async function handToChovy(
  cfg: ChovyConfig,
  brief: BuildBrief,
  ideaId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Handoff> {
  const res = await fetchImpl(`${cfg.url}/api/campaign/contexts`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      idea: briefText(brief),
      experiment: 'outreachgraph-ideas',
      variant: 'build-it',
      first_touch: {
        utm_source: 'outreachgraph',
        utm_medium: 'idea-generator',
        utm_campaign: ideaId,
      },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`chovy ${res.status}: ${text.slice(0, 200)}`);
  const body = JSON.parse(text) as Partial<Handoff>;
  if (!body.handoff_url) throw new Error('chovy returned no handoff_url');
  return body as Handoff;
}

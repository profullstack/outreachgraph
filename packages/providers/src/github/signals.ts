/**
 * Turning public GitHub activity into signals (PRD §11, §16.6).
 *
 * Deterministic classification — no model involved. An LLM may later *rank*
 * or summarise these, but the mapping from "opened a public issue" to
 * `public_question` is a rule, so it is reproducible and auditable.
 *
 * Relevance is scored against the campaign's own technologies and keywords,
 * because a repository adopting Postgres is only interesting to someone
 * selling something adjacent to it.
 */

import type { Sentiment, SignalType } from '@outreachgraph/domain';
import type { GitHubEvent, GitHubRepo } from './client';

/** A signal before it is persisted — no ids, no workspace yet. */
export interface ExtractedSignal {
  readonly type: SignalType;
  readonly subtype?: string;
  readonly summary: string;
  /** Verbatim text backing the summary; required to ground a message. */
  readonly evidence?: string;
  readonly sourceUrl?: string;
  readonly sourceTimestamp: string;
  readonly confidence: number;
  readonly relevance: number;
  readonly sentiment: Sentiment;
}

export interface ExtractionContext {
  /** Technologies the campaign cares about, lower-cased on the way in. */
  readonly technologies?: readonly string[];
  readonly keywords?: readonly string[];
  /** Competitor names; a mention becomes a `competitor_mention`. */
  readonly competitors?: readonly string[];
}

/**
 * Words that turn an issue title into a pain signal rather than a neutral one.
 * Deliberately narrow — a false "they're in pain" reading produces a tone-deaf
 * message, which is worse than missing the signal.
 */
const PAIN_TERMS = [
  'broken',
  'fails',
  'failing',
  'crash',
  'regression',
  'cannot',
  "can't",
  'unable',
  'slow',
  'timeout',
  'memory leak',
  'security',
  'vulnerability',
];

const QUESTION_TERMS = [
  'how do i',
  'how to',
  'is it possible',
  'what is the best',
  'recommend',
  'alternative',
  'anyone know',
  'looking for',
  'should i use',
];

export function extractSignals(
  events: readonly GitHubEvent[],
  repos: readonly GitHubRepo[],
  context: ExtractionContext = {},
): ExtractedSignal[] {
  const signals: ExtractedSignal[] = [];

  for (const event of events) {
    const signal = classifyEvent(event, context);
    if (signal) signals.push(signal);
  }

  for (const repo of repos) {
    signals.push(...classifyRepo(repo, context));
  }

  // Newest first; the recommendation engine wants the freshest trigger.
  return signals.sort((a, b) => b.sourceTimestamp.localeCompare(a.sourceTimestamp));
}

function classifyEvent(
  event: GitHubEvent,
  context: ExtractionContext,
): ExtractedSignal | undefined {
  const repoName = event.repo?.name;
  const repoUrl = repoName ? `https://github.com/${repoName}` : undefined;
  const payload = event.payload ?? {};

  switch (event.type) {
    case 'CreateEvent': {
      // Only repository creation is interesting; branches and tags are noise.
      if (payload.ref_type !== 'repository') return undefined;
      return {
        type: 'project_start',
        summary: `Created a new repository, ${repoName ?? 'unknown'}`,
        ...(repoUrl ? { sourceUrl: repoUrl } : {}),
        sourceTimestamp: event.created_at,
        confidence: 0.95,
        relevance: relevanceOf(repoName ?? '', context),
        sentiment: 'neutral',
      };
    }

    case 'ReleaseEvent': {
      const release = asRecord(payload.release);
      const name = asString(release?.name) ?? asString(release?.tag_name);
      return {
        type: 'launch',
        summary: `Published release ${name ?? ''} in ${repoName ?? 'a repository'}`.trim(),
        ...(asString(release?.body) ? { evidence: truncate(asString(release?.body)!) } : {}),
        ...(asString(release?.html_url) ? { sourceUrl: asString(release?.html_url)! } : {}),
        sourceTimestamp: event.created_at,
        confidence: 0.95,
        relevance: relevanceOf(`${repoName ?? ''} ${name ?? ''}`, context),
        sentiment: 'positive',
      };
    }

    case 'IssuesEvent': {
      if (payload.action !== 'opened') return undefined;
      const issue = asRecord(payload.issue);
      const title = asString(issue?.title);
      if (!title) return undefined;

      const body = asString(issue?.body);
      const haystack = `${title} ${body ?? ''}`.toLowerCase();

      const type: SignalType = QUESTION_TERMS.some((t) => haystack.includes(t))
        ? 'public_question'
        : PAIN_TERMS.some((t) => haystack.includes(t))
          ? 'pain'
          : 'community_activity';

      const competitor = (context.competitors ?? []).find((c) =>
        haystack.includes(c.toLowerCase()),
      );

      return {
        type: competitor ? 'competitor_mention' : type,
        ...(competitor ? { subtype: competitor } : {}),
        summary: `Opened an issue in ${repoName ?? 'a repository'}: ${truncate(title, 120)}`,
        // The title is the person's own words, so it can ground a reply.
        evidence: truncate(body ? `${title}\n\n${body}` : title),
        ...(asString(issue?.html_url) ? { sourceUrl: asString(issue?.html_url)! } : {}),
        sourceTimestamp: event.created_at,
        confidence: 0.85,
        relevance: relevanceOf(haystack, context),
        sentiment: type === 'pain' ? 'negative' : 'neutral',
      };
    }

    case 'PullRequestEvent': {
      if (payload.action !== 'opened') return undefined;
      const pr = asRecord(payload.pull_request);
      const title = asString(pr?.title);
      if (!title) return undefined;

      return {
        type: 'community_activity',
        summary: `Opened a pull request in ${repoName ?? 'a repository'}: ${truncate(title, 120)}`,
        evidence: truncate(title),
        ...(asString(pr?.html_url) ? { sourceUrl: asString(pr?.html_url)! } : {}),
        sourceTimestamp: event.created_at,
        confidence: 0.85,
        relevance: relevanceOf(`${repoName ?? ''} ${title}`, context),
        sentiment: 'neutral',
      };
    }

    case 'WatchEvent': {
      // Starring a repository is a weak but real interest signal.
      return {
        type: 'content_topic',
        summary: `Starred ${repoName ?? 'a repository'}`,
        ...(repoUrl ? { sourceUrl: repoUrl } : {}),
        sourceTimestamp: event.created_at,
        confidence: 0.9,
        relevance: relevanceOf(repoName ?? '', context) * 0.6,
        sentiment: 'positive',
      };
    }

    default:
      // PushEvent and friends are high-volume and low-information; ignoring
      // them keeps the feed readable.
      return undefined;
  }
}

function classifyRepo(repo: GitHubRepo, context: ExtractionContext): ExtractedSignal[] {
  // Forks describe someone else's technology choice, not this person's.
  if (repo.fork) return [];

  const signals: ExtractedSignal[] = [];
  const stack = [repo.language, ...(repo.topics ?? [])].filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  );

  const matched = (context.technologies ?? []).filter((tech) =>
    stack.some((entry) => entry.toLowerCase() === tech.toLowerCase()),
  );

  if (matched.length > 0) {
    signals.push({
      type: 'technology_adoption',
      subtype: matched[0],
      summary: `Uses ${matched.join(', ')} in ${repo.name}`,
      ...(repo.description ? { evidence: truncate(repo.description) } : {}),
      sourceUrl: repo.html_url,
      sourceTimestamp: repo.pushed_at ?? repo.created_at,
      confidence: 0.9,
      relevance: 0.9,
      sentiment: 'neutral',
    });
  }

  const competitor = (context.competitors ?? []).find((name) =>
    `${repo.name} ${repo.description ?? ''}`.toLowerCase().includes(name.toLowerCase()),
  );

  if (competitor) {
    signals.push({
      type: 'competitor_mention',
      subtype: competitor,
      summary: `Repository ${repo.name} references ${competitor}`,
      ...(repo.description ? { evidence: truncate(repo.description) } : {}),
      sourceUrl: repo.html_url,
      sourceTimestamp: repo.pushed_at ?? repo.created_at,
      confidence: 0.75,
      relevance: 0.85,
      sentiment: 'neutral',
    });
  }

  return signals;
}

/**
 * 0..1 relevance from how many campaign terms the text mentions.
 *
 * A base of 0.2 rather than 0 keeps an unmatched-but-real event visible in the
 * feed while ranking far below anything on-topic.
 */
function relevanceOf(text: string, context: ExtractionContext): number {
  const terms = [...(context.technologies ?? []), ...(context.keywords ?? [])];
  if (terms.length === 0) return 0.5;

  const haystack = text.toLowerCase();
  const hits = terms.filter((term) => haystack.includes(term.toLowerCase())).length;
  if (hits === 0) return 0.2;

  return Math.min(1, 0.5 + hits * 0.25);
}

function truncate(text: string, max = 500): string {
  const clean = text.replace(/\r/g, '').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

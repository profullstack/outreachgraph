/**
 * The model half of the hybrid.
 *
 * Runs only when the deterministic pass found nothing, which keeps a
 * well-marked-up site free and reserves the token spend for the bespoke
 * marketing pages that structured parsing cannot read.
 *
 * The model is described structurally rather than imported from
 * `@outreachgraph/ai`, so this package keeps its one rule: providers depend on
 * `domain` and nothing else. It also means a test can pass a plain object.
 */

import type { CandidateIdentity, PersonCandidate } from '../provider';
import { networkForUrl, type ExtractedCompany } from './extract';

/** The subset of `@outreachgraph/ai`'s `TextModel` this needs. */
export interface ExtractionModel {
  generate(input: {
    system: string;
    user: string;
    maxTokens?: number;
  }): Promise<{ text: string; refused: boolean }>;
}

const SYSTEM = [
  'You read the visible text of a company web page and report only what it states.',
  '',
  'Return one JSON object and nothing else:',
  '{"company":{"name":string|null,"description":string|null},',
  ' "people":[{"fullName":string,"title":string|null,"profileUrl":string|null}]}',
  '',
  'Rules:',
  '- Report only what the page states outright. Never infer, guess or complete a name.',
  '- A person needs a full personal name printed on the page. Never invent one,',
  '  and never turn a team, department, role or product into a person.',
  '- If the page names nobody, return an empty people array. That is a correct answer.',
  '- Never use knowledge from outside the page.',
].join('\n');

/** Strips markup, script and style so the model sees the page's prose. */
export function visibleText(html: string, maxChars = 12_000): string {
  const text = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

  return text.slice(0, maxChars);
}

/**
 * Pulls the JSON object out of a model reply.
 *
 * Models wrap JSON in prose or fences often enough that demanding a bare object
 * would fail on answers that are otherwise correct.
 */
function parseReply(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = (fenced ?? text).trim();

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;

  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

export interface ModelExtraction {
  readonly company: { readonly name?: string; readonly description?: string };
  readonly people: readonly PersonCandidate[];
  /**
   * Why the model produced nothing, when the reason was not the page.
   *
   * Set only for an outage — the call threw. A refusal or an unreadable reply
   * leaves this undefined, because those are answers about this page and
   * asking again would get the same one. An empty extraction on its own cannot
   * tell "the page names nobody" from "nobody was asked", and the caller has to
   * treat those differently.
   */
  readonly unavailable?: string;
}

const EMPTY: ModelExtraction = { company: {}, people: [] };

/**
 * Asks the model what the page says.
 *
 * Every failure mode returns empty rather than throwing: a refusal, an
 * unparseable reply, a model outage. None of those should fail a crawl whose
 * deterministic half may already have produced a usable company — but an
 * outage is reported on `unavailable` so the caller can tell it apart from a
 * page that genuinely names nobody.
 */
export async function extractWithModel(
  model: ExtractionModel,
  html: string,
  pageUrl: string,
  company: ExtractedCompany,
): Promise<ModelExtraction> {
  const text = visibleText(html);
  if (!text) return EMPTY;

  let reply: { text: string; refused: boolean };
  try {
    reply = await model.generate({
      system: SYSTEM,
      user: `Page URL: ${pageUrl}\n\nPage text:\n${text}`,
      maxTokens: 1200,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ...EMPTY, unavailable: reason.slice(0, 300) };
  }

  if (reply.refused) return EMPTY;

  const parsed = parseReply(reply.text);
  if (!parsed || typeof parsed !== 'object') return EMPTY;

  const root = parsed as {
    company?: { name?: unknown; description?: unknown };
    people?: unknown;
  };

  const observedAt = new Date().toISOString();
  const people: PersonCandidate[] = [];

  if (Array.isArray(root.people)) {
    for (const entry of root.people) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as { fullName?: unknown; title?: unknown; profileUrl?: unknown };

      const fullName = typeof record.fullName === 'string' ? record.fullName.trim() : '';
      // Two words minimum. A single token is a first name, a handle or a
      // department, and none of those is a person we can responsibly research.
      if (!fullName || fullName.split(/\s+/).length < 2 || fullName.length > 120) continue;

      const identities: CandidateIdentity[] = [];
      if (typeof record.profileUrl === 'string') {
        const network = networkForUrl(record.profileUrl);
        if (network) {
          identities.push({
            network,
            profileUrl: record.profileUrl,
            // Lower than a structured-data link on purpose: a model repeating a
            // URL from prose is weaker evidence than the site declaring it.
            providerConfidence: 0.5,
          });
        }
      }

      people.push({
        fullName,
        ...(typeof record.title === 'string' && record.title.trim()
          ? { title: record.title.trim() }
          : {}),
        ...(company.name ? { companyName: company.name } : {}),
        ...(company.domain ? { companyDomain: company.domain } : {}),
        identities,
        observedAt,
        sourceRecordId: pageUrl,
      });
    }
  }

  const name = typeof root.company?.name === 'string' ? root.company.name.trim() : undefined;
  const description =
    typeof root.company?.description === 'string' ? root.company.description.trim() : undefined;

  return {
    company: { ...(name ? { name } : {}), ...(description ? { description } : {}) },
    people,
  };
}

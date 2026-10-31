import type { TextModel } from './model';

export type ContentKind = 'social' | 'newsletter' | 'article';

export interface ContentDraftInput {
  readonly kind: ContentKind;
  readonly topic: string;
  readonly audience?: string | undefined;
  readonly notes?: string | undefined;
  readonly brand?:
    | {
        readonly name: string;
        readonly description?: string | undefined;
        readonly valuePropositions?: readonly string[] | undefined;
      }
    | undefined;
  readonly voice?:
    | {
        readonly style: string;
        readonly instructions?: string | undefined;
        readonly maxWords?: number | undefined;
      }
    | undefined;
}

export interface ContentDraftResult {
  readonly title: string;
  readonly body: string;
  readonly model: string;
}

const KIND_LABELS: Record<ContentKind, string> = {
  social: 'a LinkedIn post',
  newsletter: 'a founder newsletter issue',
  article: 'a practical long-form blog article',
};

function parseDraft(raw: string, fallbackTitle: string): { title: string; body: string } {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = (fenced ?? raw).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed: unknown = JSON.parse(candidate.slice(start, end + 1));
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as Record<string, unknown>).body === 'string'
      ) {
        const value = parsed as { title?: unknown; body: string };
        const body = value.body.trim();
        if (body) {
          return {
            title:
              typeof value.title === 'string' && value.title.trim()
                ? value.title.trim().slice(0, 240)
                : fallbackTitle,
            body,
          };
        }
      }
    } catch {
      // A plain-text answer below is still usable if JSON was malformed.
    }
  }

  const heading = candidate.match(/^(?:#\s+|(?:title|subject)\s*:\s*)([^\n]+)\n+([\s\S]*)$/i);
  if (heading?.[2]?.trim()) {
    return { title: heading[1]!.trim().slice(0, 240), body: heading[2].trim() };
  }
  return { title: fallbackTitle, body: candidate };
}

/** Drafts founder content in a product's saved voice. It never publishes. */
export async function draftContent(
  model: TextModel,
  input: ContentDraftInput,
): Promise<ContentDraftResult> {
  const system = [
    `Write ${KIND_LABELS[input.kind]} for a small team or founder.`,
    'Sound specific, clear, and human. Prefer concrete language and short paragraphs.',
    'Do not invent customer stories, statistics, product capabilities, quotes, or research.',
    'Use only the supplied product facts. If a useful detail is missing, leave it out.',
    'Avoid generic AI filler, inflated claims, fake urgency, and forced calls to action.',
    'Return only JSON with this shape: {"title":"short working title","body":"finished copy"}.',
  ].join('\n');

  const lines = [
    `FORMAT: ${KIND_LABELS[input.kind]}`,
    `TOPIC: ${input.topic.trim()}`,
    input.audience?.trim() ? `AUDIENCE: ${input.audience.trim()}` : '',
    input.brand ? `PRODUCT: ${input.brand.name}` : '',
    input.brand?.description ? `PRODUCT DESCRIPTION: ${input.brand.description}` : '',
    input.brand?.valuePropositions?.length
      ? `KNOWN VALUE: ${input.brand.valuePropositions.join('; ')}`
      : '',
    input.voice ? `VOICE STYLE: ${input.voice.style}` : '',
    input.voice?.instructions ? `VOICE NOTES: ${input.voice.instructions}` : '',
    input.voice?.maxWords ? `Keep the body under ${input.voice.maxWords} words.` : '',
    input.kind === 'social'
      ? 'Write one LinkedIn post, around 120–220 words. Use a natural opening and no hashtags unless requested.'
      : '',
    input.kind === 'newsletter'
      ? 'Write a useful newsletter issue of about 350–500 words, with one clear takeaway and a concise subject line as title.'
      : '',
    input.kind === 'article'
      ? 'Write a practical article of about 900–1,300 words with a useful headline, informative subheads, and a concrete conclusion.'
      : '',
    input.notes?.trim() ? `SOURCE NOTES AND DIRECTION:\n${input.notes.trim()}` : '',
  ].filter(Boolean);

  const result = await model.generate({
    system,
    user: lines.join('\n\n'),
    maxTokens: input.kind === 'article' ? 5000 : input.kind === 'newsletter' ? 2400 : 1200,
  });
  if (result.refused || !result.text.trim()) {
    return { title: input.topic.trim().slice(0, 240), body: '', model: result.model };
  }
  return { ...parseDraft(result.text, input.topic.trim()), model: result.model };
}

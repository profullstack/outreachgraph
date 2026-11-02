/**
 * The Content Radar's writing half: why a post got attention, and the same
 * structure turned into something for the workspace's own product.
 *
 *   hooks      each reference gets a hook type from a fixed list, one sentence
 *              on why it stopped people, and an angle the product could take.
 *              Without a model, the wording decides the type and says so.
 *   studio     a reference becomes a short-video storyboard (hook, story,
 *              invitation) and a branded image card (headline, support line,
 *              caption). The card is rendered from a template, not generated.
 *
 * Nothing here is allowed to copy the reference. The prompt passes the post as
 * an example of a structure and asks for the product's own facts in it.
 */

import type { TextModel } from './model';

export const HOOK_TYPES = [
  'contrarian',
  'question',
  'story',
  'how_to',
  'list',
  'data',
  'mindset_shift',
  'fresh_angle',
  'launch',
  'behind_the_scenes',
  'audience_conversation',
  'product_positioning',
] as const;
export type HookType = (typeof HOOK_TYPES)[number];

export const HOOK_LABELS: Record<HookType, string> = {
  contrarian: 'Contrarian hook',
  question: 'Open question',
  story: 'Storytelling',
  how_to: 'How-to',
  list: 'List',
  data: 'Numbers first',
  mindset_shift: 'Mindset shift',
  fresh_angle: 'Fresh angle',
  launch: 'Launch',
  behind_the_scenes: 'Behind the scenes',
  audience_conversation: 'Audience conversation',
  product_positioning: 'Product positioning',
};

export function isHookType(value: string): value is HookType {
  return (HOOK_TYPES as readonly string[]).includes(value);
}

/** Ordered most specific first, like the listening classifier. */
const HOOK_PATTERNS: readonly { readonly type: HookType; readonly test: RegExp }[] = [
  { type: 'launch', test: /\b(?:show hn|launch(?:ed|ing)?|just shipped|introducing|v\d+\.\d+)\b/i },
  {
    type: 'contrarian',
    test: /\b(?:stop(?:ped)?\s+\w+ing|unpopular opinion|is (?:dead|overrated)|you don'?t need|nobody tells you|myth|wrong about)\b/i,
  },
  { type: 'data', test: /\b\d[\d,.]*\s?(?:%|percent|x\b|users|customers|hours|days|\$|k\b|mrr)/i },
  { type: 'how_to', test: /\b(?:how (?:i|we|to)|guide|step[- ]by[- ]step|tutorial)\b/i },
  { type: 'list', test: /^\s*(?:\d+|three|five|seven|ten)\s+\w+/i },
  {
    type: 'behind_the_scenes',
    test: /\b(?:building in public|behind the scenes|what i learned|lessons from|month \d+|day \d+)\b/i,
  },
  {
    type: 'story',
    test: /\b(?:i (?:was|used to|spent|quit|deleted|stopped)|last (?:year|week|month)|when i)\b/i,
  },
  {
    type: 'mindset_shift',
    test: /\b(?:instead of|isn'?t about|reframe|the real reason|actually)\b/i,
  },
];

/** The hook the wording alone suggests, for when there is no model. */
export function heuristicHook(text: string): HookType {
  for (const pattern of HOOK_PATTERNS) if (pattern.test.test(text)) return pattern.type;
  if (/\?\s*$|\?\s/.test(text)) return 'question';
  return 'fresh_angle';
}

export interface RadarBrand {
  readonly name: string;
  readonly url?: string | undefined;
  readonly description?: string | undefined;
  readonly valuePropositions?: readonly string[] | undefined;
}

export interface HookInput {
  readonly id: string;
  readonly source: string;
  readonly title?: string | undefined;
  readonly text: string;
  readonly likes: number;
  readonly reposts: number;
  readonly comments: number;
}

export interface HookAnalysis {
  readonly id: string;
  readonly hookType: HookType;
  readonly why: string;
  readonly angle: string;
  /**
   * Whether the post's subject matters to the product's audience. A big
   * account's post about its holiday decorations got attention too, but
   * borrowing its hook for a habit tracker would be noise.
   */
  readonly relevant: boolean;
}

const HOOK_SYSTEM = [
  'You study social posts that got attention, for a founder who wants to market their own product.',
  `For each post pick its hook type from exactly this list: ${HOOK_TYPES.join(', ')}.`,
  'Then write "why": one plain sentence on why the opening made people stop, react or reply.',
  'Then write "angle": one sentence on how the founder\'s product could use the same structure with',
  'its own facts. Never suggest copying the post. Never invent product features.',
  'Then "relevant": true only when the post is about the product\'s niche, its problem, its audience',
  'or building and marketing products like it; false for news, politics, jokes and personal posts.',
  'Return only JSON: {"results":[{"id":"...","hook":"...","why":"...","angle":"...","relevant":true}]}.',
].join('\n');

function brandLines(brand: RadarBrand): string {
  return [
    `PRODUCT: ${brand.name}`,
    brand.url ? `URL: ${brand.url}` : '',
    brand.description ? `WHAT IT DOES: ${brand.description.slice(0, 800)}` : '',
    brand.valuePropositions?.length
      ? `KNOWN VALUE: ${brand.valuePropositions.slice(0, 6).join('; ')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function jsonObjectIn(raw: string): Record<string, unknown> | undefined {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? raw;
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(fenced.slice(start, end + 1));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function parseHookAnalyses(raw: string): HookAnalysis[] {
  const parsed = jsonObjectIn(raw);
  const results = Array.isArray(parsed?.results) ? (parsed.results as unknown[]) : [];
  return results.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const value = entry as Record<string, unknown>;
    const id = typeof value.id === 'string' || typeof value.id === 'number' ? String(value.id) : '';
    const hook = String(value.hook ?? value.hookType ?? '')
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_');
    if (!id) return [];
    return [
      {
        id,
        hookType: isHookType(hook) ? hook : 'fresh_angle',
        why: String(value.why ?? '')
          .trim()
          .slice(0, 400),
        angle: String(value.angle ?? '')
          .trim()
          .slice(0, 400),
        // Only an explicit no excludes a post: a model that omits the field
        // should not empty the feed.
        relevant: !(value.relevant === false || value.relevant === 'false'),
      },
    ];
  });
}

/** Up to ten posts per call; ids the model drops are simply not analysed. */
export async function analyzeHooks(
  model: TextModel,
  brand: RadarBrand,
  posts: readonly HookInput[],
): Promise<HookAnalysis[]> {
  if (posts.length === 0) return [];
  const user = [
    brandLines(brand),
    ...posts
      .slice(0, 10)
      .map((post) =>
        [
          `--- id: ${post.id} (${post.source}; ${post.likes} likes, ${post.reposts} reposts, ${post.comments} comments)`,
          post.title ? `TITLE: ${post.title}` : '',
          post.text.slice(0, 900),
        ]
          .filter(Boolean)
          .join('\n'),
      ),
  ].join('\n\n');
  const result = await model.generate({ system: HOOK_SYSTEM, user, maxTokens: 2400 });
  if (result.refused) return [];
  const known = new Set(posts.map((post) => post.id));
  return parseHookAnalyses(result.text).filter((analysis) => known.has(analysis.id));
}

/* ------------------------------------------------------------- studio */

export interface StoryboardScene {
  readonly beat: 'hook' | 'story' | 'invitation';
  /** Words on screen, a handful at most. */
  readonly onScreen: string;
  readonly voiceover: string;
  /** What the camera or screen recording shows. */
  readonly shot: string;
  readonly seconds: number;
}

export interface Storyboard {
  readonly title: string;
  readonly scenes: readonly StoryboardScene[];
  readonly caption: string;
}

export interface ImageCard {
  readonly eyebrow: string;
  readonly headline: string;
  readonly support: string;
  readonly footer: string;
  readonly caption: string;
}

export interface StudioInput {
  readonly brand: RadarBrand;
  readonly voice?: { readonly style: string; readonly instructions?: string | undefined };
  readonly reference: {
    readonly source: string;
    readonly title?: string | undefined;
    readonly text: string;
    readonly hookType?: string | undefined;
    readonly why?: string | undefined;
    readonly angle?: string | undefined;
  };
}

export interface StudioResult {
  readonly storyboard?: Storyboard;
  readonly image?: ImageCard;
  readonly model: string;
}

const STUDIO_SYSTEM = [
  'You turn a post that got attention into marketing material for a different, real product.',
  'Borrow the structure and the kind of hook, never the words, the topic details or the author.',
  'Use only the product facts given. No invented numbers, customers, quotes or features.',
  'Write like a person: concrete, short, no hype, no hashtags, no stock openers.',
  'Return only JSON with this shape:',
  '{"storyboard":{"title":"...","caption":"...","scenes":[{"beat":"hook|story|invitation",',
  '"onScreen":"max 8 words","voiceover":"one or two sentences","shot":"what is shown","seconds":3}]},',
  '"image":{"eyebrow":"PRODUCT NAME","headline":"max 9 words","support":"max 16 words",',
  '"footer":"max 6 words","caption":"the post text that goes with the image"}}',
  'The storyboard has 3 to 5 scenes and runs 15 to 35 seconds: one hook scene first and one invitation last.',
].join('\n');

function clip(value: unknown, max: number): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function parseStudio(raw: string, fallbackName: string): Omit<StudioResult, 'model'> {
  const parsed = jsonObjectIn(raw);
  if (!parsed) return {};
  const out: { storyboard?: Storyboard; image?: ImageCard } = {};
  const board = parsed.storyboard as Record<string, unknown> | undefined;
  if (board && Array.isArray(board.scenes)) {
    const scenes = (board.scenes as Record<string, unknown>[])
      .slice(0, 6)
      .map((scene, index, all): StoryboardScene => {
        const beat = String(scene.beat ?? '').toLowerCase();
        return {
          beat:
            beat === 'hook' || beat === 'story' || beat === 'invitation'
              ? beat
              : index === 0
                ? 'hook'
                : index === all.length - 1
                  ? 'invitation'
                  : 'story',
          onScreen: clip(scene.onScreen, 80),
          voiceover: clip(scene.voiceover, 300),
          shot: clip(scene.shot, 200),
          seconds: Math.max(1, Math.min(15, Math.round(Number(scene.seconds) || 4))),
        };
      })
      .filter((scene) => scene.onScreen || scene.voiceover);
    if (scenes.length) {
      out.storyboard = {
        title: clip(board.title, 120) || `${fallbackName} short`,
        caption: clip(board.caption, 600),
        scenes,
      };
    }
  }
  const image = parsed.image as Record<string, unknown> | undefined;
  if (image && clip(image.headline, 120)) {
    out.image = {
      eyebrow: clip(image.eyebrow, 40) || fallbackName.toUpperCase(),
      headline: clip(image.headline, 90),
      support: clip(image.support, 140),
      footer: clip(image.footer, 60),
      caption: clip(image.caption, 900),
    };
  }
  return out;
}

/** A storyboard and an image card from one reference, in the product's voice. */
export async function draftStudio(model: TextModel, input: StudioInput): Promise<StudioResult> {
  const user = [
    brandLines(input.brand),
    input.voice ? `VOICE: ${input.voice.style}` : '',
    input.voice?.instructions ? `VOICE NOTES: ${input.voice.instructions}` : '',
    `REFERENCE POST (${input.reference.source}), an example of the structure only:`,
    input.reference.title ? `TITLE: ${input.reference.title}` : '',
    input.reference.text.slice(0, 1200),
    input.reference.hookType ? `HOOK TYPE: ${input.reference.hookType}` : '',
    input.reference.why ? `WHY IT WORKED: ${input.reference.why}` : '',
    input.reference.angle ? `SUGGESTED ANGLE: ${input.reference.angle}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const result = await model.generate({ system: STUDIO_SYSTEM, user, maxTokens: 1800 });
  if (result.refused) return { model: result.model };
  return { ...parseStudio(result.text, input.brand.name), model: result.model };
}

/**
 * Direction for the per-network post writer: the reference as a structure to
 * borrow. Passed as the link-post notes, so the posts that come back are the
 * ordinary hand-off cards (and auto-post where the network allows).
 */
export function referenceDirection(reference: StudioInput['reference']): string {
  return [
    'Use this post that did well as a model for the HOOK and STRUCTURE only. Do not copy its words,',
    'topic or claims, and do not mention it. Write about our product with our own facts.',
    reference.hookType ? `Hook type: ${reference.hookType}.` : '',
    reference.why ? `Why it worked: ${reference.why}` : '',
    reference.angle ? `Angle for us: ${reference.angle}` : '',
    `Reference (${reference.source}): ${[reference.title, reference.text].filter(Boolean).join(' - ').slice(0, 700)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/* ------------------------------------------------------------ image card */

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Greedy word wrap by character count; good enough for a fixed-width card. */
export function wrapLines(text: string, perLine: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (!line) line = word;
    else if (`${line} ${word}`.length <= perLine) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1]!.replace(/[.,;:!?]?$/, '')}…`;
    return kept;
  }
  return lines;
}

/**
 * A 1080x1350 (Instagram portrait) SVG of the card. Rendered from the copy,
 * not by an image model: free, instant, and always on brand. Browsers export
 * it to PNG.
 */
export function renderImageCardSvg(
  card: ImageCard,
  colors: { readonly background?: string; readonly ink?: string; readonly accent?: string } = {},
): string {
  const bg = colors.background ?? '#0f172a';
  const ink = colors.ink ?? '#f8fafc';
  const accent = colors.accent ?? '#38bdf8';
  const headline = wrapLines(card.headline, 16, 5);
  const support = wrapLines(card.support, 34, 4);
  const headStart = 420;
  const headStep = 112;
  const supportStart = headStart + headline.length * headStep + 50;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350" viewBox="0 0 1080 1350">`,
    `<rect width="1080" height="1350" fill="${escapeXml(bg)}"/>`,
    `<rect x="90" y="150" width="120" height="10" rx="5" fill="${escapeXml(accent)}"/>`,
    `<text x="90" y="250" font-family="Inter, Helvetica, Arial, sans-serif" font-size="40" font-weight="700" letter-spacing="6" fill="${escapeXml(accent)}">${escapeXml(card.eyebrow.toUpperCase())}</text>`,
    ...headline.map(
      (line, i) =>
        `<text x="90" y="${headStart + i * headStep}" font-family="Inter, Helvetica, Arial, sans-serif" font-size="96" font-weight="800" fill="${escapeXml(ink)}">${escapeXml(line)}</text>`,
    ),
    ...support.map(
      (line, i) =>
        `<text x="90" y="${supportStart + i * 58}" font-family="Inter, Helvetica, Arial, sans-serif" font-size="44" fill="${escapeXml(ink)}" fill-opacity="0.78">${escapeXml(line)}</text>`,
    ),
    card.footer
      ? `<text x="90" y="1240" font-family="Inter, Helvetica, Arial, sans-serif" font-size="38" font-weight="600" fill="${escapeXml(accent)}">${escapeXml(card.footer)}</text>`
      : '',
    `</svg>`,
  ].join('');
}

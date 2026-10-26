/**
 * The "brain repo": a product's positioning, voice, audience and objections as
 * plain markdown files, so a marketing team can keep them in a private git
 * repository and every teammate's AI reads the same thing.
 *
 * The layout is shared with myna and must not drift:
 *
 *   knowledge/positioning.md   what it is, who it is for, why it is different
 *   knowledge/voice.md         brand voice
 *   knowledge/audience.md      ICP
 *   knowledge/objections.md    what prospects push back on or ask
 *   skills/                    myna's, ignored here
 *
 * A brain holding several products puts each under `knowledge/<slug>/`.
 *
 * Each file is YAML-ish frontmatter (scalars and flat lists only) plus a
 * markdown body with `## Section` headings. Positioning and voice round-trip;
 * audience and objections are written for people and models to read and are
 * not imported back.
 *
 * Pure: no I/O, no clock unless one is passed in.
 */

export interface BrainProduct {
  readonly offeringId?: string;
  readonly name: string;
  readonly url?: string | null;
  readonly category: string;
  readonly description?: string | null;
  readonly valuePropositions: readonly string[];
  readonly likelyPains: readonly string[];
  readonly competitors: readonly string[];
}

export interface BrainVoice {
  readonly name?: string;
  readonly style: string;
  readonly instructions?: string | null;
  readonly maxWords?: number | null;
  readonly samples: readonly string[];
  readonly prohibitedClaims: readonly string[];
}

export interface BrainAudience {
  readonly titles: readonly string[];
  readonly seniorities: readonly string[];
  readonly industries: readonly string[];
  readonly countries: readonly string[];
  readonly technologies: readonly string[];
  readonly keywords: readonly string[];
  readonly exclusions: readonly string[];
}

export interface BrainObjectionItem {
  readonly reason: string;
  readonly excerpt: string;
}

export interface BrainObjectionGroup {
  readonly label: string;
  readonly count: number;
  readonly items: readonly BrainObjectionItem[];
}

export interface BrainObjections {
  readonly replies: number;
  readonly from?: string;
  readonly to?: string;
  readonly groups: readonly BrainObjectionGroup[];
}

export interface BrainProfile {
  readonly product: BrainProduct;
  readonly voice?: BrainVoice;
}

export interface BrainExtras {
  readonly audience?: BrainAudience;
  readonly objections?: BrainObjections;
  /** Multi-product brains write under `knowledge/<slug>/`. */
  readonly slug?: string;
  readonly exportedAt?: string;
}

/** What an import found. Absent keys were not in the files and stay as they are. */
export interface ParsedBrain {
  readonly product?: Partial<Omit<BrainProduct, 'offeringId'>>;
  readonly voice?: Partial<Omit<BrainVoice, 'name'>>;
}

export const BRAIN_FILES = ['positioning', 'voice', 'audience', 'objections'] as const;
export type BrainFile = (typeof BRAIN_FILES)[number];

/** A slug safe to use as one directory name. */
export function brainSlug(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s.-]/g, '')
    .replace(/[\s_.]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
}

export function brainPath(file: BrainFile, slug?: string): string {
  const clean = slug ? brainSlug(slug) : '';
  return clean ? `knowledge/${clean}/${file}.md` : `knowledge/${file}.md`;
}

// ------------------------------------------------------------ frontmatter

export type FrontmatterValue = string | readonly string[];

/** Quotes a scalar only when YAML would read it as something else. */
function scalar(value: string): string {
  const flat = value.replace(/\s*\n\s*/g, ' ').trim();
  if (flat === '') return '""';
  if (/^[\w./@+-][^:#]*$/.test(flat) && !/^(true|false|null|yes|no|~)$/i.test(flat)) {
    if (!/[[\]{},&*!|>'"%`]/.test(flat) && !/\s$/.test(flat)) return flat;
  }
  return JSON.stringify(flat);
}

export function renderFrontmatter(data: Readonly<Record<string, FrontmatterValue | number>>) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      if (value.length === 0) lines.push(`${key}: []`);
      else {
        lines.push(`${key}:`);
        for (const item of value) lines.push(`  - ${scalar(item)}`);
      }
    } else {
      lines.push(`${key}: ${typeof value === 'number' ? String(value) : scalar(value as string)}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      return String(JSON.parse(value));
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

/** Splits `[a, "b, c", d]` on the commas outside quotes. */
function inlineList(raw: string): string[] {
  const inner = raw.trim().slice(1, -1);
  const items: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]!;
    if (quote) {
      current += ch;
      if (ch === '\\' && quote === '"' && i + 1 < inner.length) {
        current += inner[i + 1];
        i += 1;
      } else if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ',') {
      items.push(current);
      current = '';
    } else current += ch;
  }
  if (current.trim()) items.push(current);
  return items.map(unquote).filter((item) => item !== '');
}

/**
 * Reads the frontmatter a brain file carries: `key: value`, `key: [a, b]` and
 * `key:` followed by `- item` lines. Nothing nested, because nothing written
 * here nests and a full YAML parser is a dependency this does not need.
 */
export function parseFrontmatter(text: string): {
  data: Record<string, FrontmatterValue>;
  body: string;
} {
  const normalised = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalised);
  if (!match) return { data: {}, body: normalised };

  const data: Record<string, FrontmatterValue> = {};
  let listKey: string | undefined;

  for (const line of match[1]!.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) {
      const existing = data[listKey];
      const list = Array.isArray(existing) ? [...existing] : [];
      const value = unquote(item[1]!);
      if (value) list.push(value);
      data[listKey] = list;
      continue;
    }

    const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!pair) continue;
    const key = pair[1]!;
    const raw = pair[2]!.trim();
    listKey = undefined;

    if (raw === '') {
      data[key] = [];
      listKey = key;
    } else if (raw.startsWith('[') && raw.endsWith(']')) {
      data[key] = inlineList(raw);
    } else {
      data[key] = /^["']/.test(raw) ? unquote(raw) : raw.replace(/\s+#.*$/, '').trim();
    }
  }

  return { data, body: normalised.slice(match[0].length) };
}

function fmString(data: Record<string, FrontmatterValue>, key: string): string | undefined {
  const value = data[key];
  if (typeof value === 'string') return value.trim() || undefined;
  return undefined;
}

// ------------------------------------------------------------ markdown body

interface Sections {
  /** The text of the first `# ` heading. */
  readonly title?: string;
  /** Text between the title and the first `## ` heading. */
  readonly lead: string;
  /** Lower-cased `## ` heading → its raw text. */
  readonly sections: ReadonlyMap<string, string>;
}

function splitSections(body: string): Sections {
  const lines = body.split('\n');
  let title: string | undefined;
  const lead: string[] = [];
  const sections = new Map<string, string[]>();
  let current: string[] | undefined;
  let fence = false;

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence) {
      const h2 = /^##\s+(.+?)\s*#*\s*$/.exec(line);
      if (h2 && !line.startsWith('###')) {
        current = [];
        sections.set(h2[1]!.toLowerCase().replace(/\s+/g, ' '), current);
        continue;
      }
      const h1 = /^#\s+(.+?)\s*#*\s*$/.exec(line);
      if (h1 && title === undefined && !current) {
        title = h1[1]!;
        continue;
      }
    }
    (current ?? lead).push(line);
  }

  return {
    ...(title !== undefined ? { title } : {}),
    lead: lead.join('\n').trim(),
    sections: new Map([...sections].map(([k, v]) => [k, v.join('\n').trim()])),
  };
}

function section(parsed: Sections, ...names: string[]): string | undefined {
  for (const name of names) {
    const found = parsed.sections.get(name);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** `- item` / `* item` / `1. item` lines, with indented continuation lines folded in. */
export function parseList(text: string): string[] {
  const items: string[] = [];
  let current: string | undefined;
  for (const line of text.split('\n')) {
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      if (current !== undefined && current.trim()) items.push(current.trim());
      current = item[1]!;
    } else if (current !== undefined && /^\s+\S/.test(line)) {
      current += ` ${line.trim()}`;
    } else if (!line.trim()) {
      if (current !== undefined && current.trim()) items.push(current.trim());
      current = undefined;
    }
  }
  if (current !== undefined && current.trim()) items.push(current.trim());
  return items;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function bullets(values: readonly string[], empty = '_None yet._'): string {
  const items = values.map(oneLine).filter(Boolean);
  return items.length === 0 ? empty : items.map((v) => `- ${v}`).join('\n');
}

/** A blockquote per sample; blank `>` lines keep a sample's own paragraphs. */
function quoteSample(sample: string): string {
  return sample
    .trim()
    .split('\n')
    .map((line) => (line.trim() ? `> ${line.trimEnd()}` : '>'))
    .join('\n');
}

/**
 * Samples as written: blockquote paragraphs (one sample per run of `>` lines)
 * or `### Sample n` subsections, whichever the file uses.
 */
export function parseSamples(text: string): string[] {
  if (/^###\s+/m.test(text)) {
    const samples: string[] = [];
    let current: string[] | undefined;
    for (const line of text.split('\n')) {
      if (/^###\s+/.test(line)) {
        if (current) samples.push(current.join('\n').trim());
        current = [];
        continue;
      }
      current?.push(line.replace(/^>\s?/, ''));
    }
    if (current) samples.push(current.join('\n').trim());
    return samples.filter(Boolean);
  }

  const samples: string[] = [];
  let current: string[] | undefined;
  for (const line of text.split('\n')) {
    const quoted = /^\s*>\s?(.*)$/.exec(line);
    if (quoted) {
      (current ??= []).push(quoted[1]!);
    } else if (current) {
      samples.push(current.join('\n').trim());
      current = undefined;
    }
  }
  if (current) samples.push(current.join('\n').trim());
  return samples.filter(Boolean);
}

// ------------------------------------------------------------ render

const AUDIENCE_SECTIONS: ReadonlyArray<readonly [keyof BrainAudience, string]> = [
  ['titles', 'Titles'],
  ['seniorities', 'Seniorities'],
  ['industries', 'Industries'],
  ['countries', 'Countries'],
  ['technologies', 'Technologies'],
  ['keywords', 'Keywords'],
  ['exclusions', 'Exclusions'],
];

const OBJECTION_HEADINGS: Readonly<Record<string, string>> = {
  not_interested: 'Not interested',
  question: 'Questions',
  referral: 'Referrals',
};

function renderPositioning(product: BrainProduct, exportedAt: string): string {
  const front = renderFrontmatter({
    product: product.name,
    url: product.url ?? '',
    category: product.category,
    source: 'outreachgraph',
    ...(product.offeringId ? { offering_id: product.offeringId } : {}),
    exported_at: exportedAt,
  });

  return [
    front,
    `# ${oneLine(product.name)}`,
    '',
    product.description?.trim() || '_No description yet._',
    '',
    '## Value propositions',
    '',
    bullets(product.valuePropositions),
    '',
    '## Problems it solves',
    '',
    bullets(product.likelyPains),
    '',
    '## Competitors',
    '',
    bullets(product.competitors),
    '',
  ].join('\n');
}

function renderVoice(voice: BrainVoice, productName: string): string {
  const front = renderFrontmatter({
    name: voice.name ?? productName,
    style: voice.style,
    ...(voice.maxWords ? { max_words: voice.maxWords } : {}),
  });

  const samples =
    voice.samples.length === 0 ? '_No samples yet._' : voice.samples.map(quoteSample).join('\n\n');

  return [
    front,
    `# Voice: ${oneLine(productName)}`,
    '',
    '## Instructions',
    '',
    voice.instructions?.trim() || '_None yet._',
    '',
    '## Samples',
    '',
    samples,
    '',
    '## Never claim',
    '',
    bullets(voice.prohibitedClaims),
    '',
  ].join('\n');
}

function renderAudience(audience: BrainAudience, productName: string, exportedAt: string): string {
  const body: string[] = [];
  for (const [key, heading] of AUDIENCE_SECTIONS) {
    const values = audience[key];
    // Exclusions only when there are some; the rest always, so a reader sees
    // what is unset rather than wondering whether the export skipped it.
    if (key === 'exclusions' && values.length === 0) continue;
    body.push(`## ${heading}`, '', bullets(values), '');
  }

  return [
    renderFrontmatter({ product: productName, source: 'outreachgraph', exported_at: exportedAt }),
    `# Audience: ${oneLine(productName)}`,
    '',
    'Who this product is sold to, merged from the targeting of every campaign that sells it.',
    '',
    ...body,
  ].join('\n');
}

function renderObjections(
  objections: BrainObjections,
  productName: string,
  exportedAt: string,
): string {
  const window =
    objections.from && objections.to
      ? ` between ${objections.from.slice(0, 10)} and ${objections.to.slice(0, 10)}`
      : '';

  const body: string[] = [];
  for (const group of objections.groups) {
    const heading = OBJECTION_HEADINGS[group.label] ?? group.label;
    body.push(`## ${heading} (${group.count})`, '');
    for (const item of group.items) {
      const excerpt = item.excerpt ? `: "${item.excerpt.replace(/"/g, "'")}"` : '';
      body.push(`- **${oneLine(item.reason).replace(/\*/g, '')}**${excerpt}`);
    }
    body.push('');
  }

  return [
    renderFrontmatter({
      product: productName,
      source: 'outreachgraph',
      replies: objections.replies,
      ...(objections.from ? { from: objections.from } : {}),
      ...(objections.to ? { to: objections.to } : {}),
      exported_at: exportedAt,
    }),
    `# Objections: ${oneLine(productName)}`,
    '',
    objections.replies === 0
      ? 'No classified pushback, questions or referrals yet.'
      : `What prospects pushed back on, asked or redirected, from ${objections.replies} classified ` +
        `repl${objections.replies === 1 ? 'y' : 'ies'}${window}. Each line is the classifier's ` +
        'reason and the first sentence of the reply, with names, emails, numbers and links removed.',
    '',
    ...body,
  ].join('\n');
}

/** Every file of one product's brain, keyed by its path inside the brain repo. */
export function renderBrain(
  profile: BrainProfile,
  extras: BrainExtras = {},
): Record<string, string> {
  const exportedAt = extras.exportedAt ?? new Date().toISOString();
  const name = profile.product.name;
  const files: Record<string, string> = {
    [brainPath('positioning', extras.slug)]: renderPositioning(profile.product, exportedAt),
  };
  if (profile.voice) files[brainPath('voice', extras.slug)] = renderVoice(profile.voice, name);
  if (extras.audience) {
    files[brainPath('audience', extras.slug)] = renderAudience(extras.audience, name, exportedAt);
  }
  if (extras.objections) {
    files[brainPath('objections', extras.slug)] = renderObjections(
      extras.objections,
      name,
      exportedAt,
    );
  }
  return files;
}

// ------------------------------------------------------------ parse

const PLACEHOLDER = /^_(no .* yet|none yet)\._$/i;

function clean(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  return PLACEHOLDER.test(trimmed) ? '' : trimmed;
}

function list(text: string | undefined): string[] | undefined {
  if (text === undefined) return undefined;
  return parseList(text).filter((item) => !PLACEHOLDER.test(item));
}

/**
 * Finds a brain file among `files`: under `knowledge/<slug>/` when a slug is
 * given, else `knowledge/`, else the only product directory there is.
 */
function findFile(
  files: Readonly<Record<string, string>>,
  file: BrainFile,
  slug?: string,
): string | undefined {
  const normalised = new Map(
    Object.entries(files).map(([path, content]) => [path.replace(/^\.?\/+/, ''), content]),
  );
  if (slug) return normalised.get(brainPath(file, slug));
  const flat = normalised.get(brainPath(file));
  if (flat !== undefined) return flat;
  const nested = [...normalised.keys()].filter((path) =>
    new RegExp(`^knowledge/[^/]+/${file}\\.md$`).test(path),
  );
  return nested.length === 1 ? normalised.get(nested[0]!) : undefined;
}

export function parsePositioning(text: string): NonNullable<ParsedBrain['product']> {
  const { data, body } = parseFrontmatter(text);
  const parsed = splitSections(body);
  const name = fmString(data, 'product') ?? parsed.title?.trim();
  // An empty lead is "not written", the placeholder is "deliberately empty".
  const description = parsed.lead ? clean(parsed.lead) : undefined;
  const url = fmString(data, 'url');
  const category = fmString(data, 'category');
  const valuePropositions = list(section(parsed, 'value propositions', 'value proposition'));
  const likelyPains = list(section(parsed, 'problems it solves', 'pains', 'likely pains'));
  const competitors = list(section(parsed, 'competitors', 'alternatives'));

  return {
    ...(name ? { name } : {}),
    ...(category ? { category } : {}),
    ...(data.url !== undefined ? { url: url ?? null } : {}),
    ...(description !== undefined ? { description: description || null } : {}),
    ...(valuePropositions ? { valuePropositions } : {}),
    ...(likelyPains ? { likelyPains } : {}),
    ...(competitors ? { competitors } : {}),
  };
}

export function parseVoice(text: string): NonNullable<ParsedBrain['voice']> {
  const { data, body } = parseFrontmatter(text);
  const parsed = splitSections(body);
  const style = fmString(data, 'style');
  const maxRaw = fmString(data, 'max_words');
  const maxWords = maxRaw && /^\d+$/.test(maxRaw) ? Number(maxRaw) : undefined;
  const instructions = clean(section(parsed, 'instructions'));
  const samplesText = section(parsed, 'samples', 'examples');
  const samples = samplesText === undefined ? undefined : parseSamples(samplesText);
  const prohibitedClaims = list(section(parsed, 'never claim', 'prohibited claims'));

  return {
    ...(style ? { style } : {}),
    ...(maxWords ? { maxWords } : data.max_words !== undefined ? { maxWords: null } : {}),
    ...(instructions !== undefined ? { instructions: instructions || null } : {}),
    ...(samples ? { samples } : {}),
    ...(prohibitedClaims ? { prohibitedClaims } : {}),
  };
}

/**
 * Reads positioning and voice back from a brain's files. Audience and
 * objections are export-only and ignored here, as is `skills/`.
 */
export function parseBrainFiles(
  files: Readonly<Record<string, string>>,
  options: { slug?: string } = {},
): ParsedBrain {
  const positioning = findFile(files, 'positioning', options.slug);
  const voice = findFile(files, 'voice', options.slug);
  return {
    ...(positioning !== undefined ? { product: parsePositioning(positioning) } : {}),
    ...(voice !== undefined ? { voice: parseVoice(voice) } : {}),
  };
}

// ------------------------------------------------------------ objections

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/gi;
const BARE_DOMAIN = /\b[\w-]+(?:\.[\w-]+)*\.(?:com|net|org|io|dev|ai|co|app|xyz|me|us|uk)\b\S*/gi;
const PHONE = /(?:\+?\d[\d\s().-]{6,}\d)/g;
const GREETING =
  /^\s*(?:hi|hello|hey|dear|hiya|morning|good (?:morning|afternoon|evening))\b(?:\s+[A-Za-z][\w'-]*){0,2}?\s*[,.!:\u2013\u2014-]\s*/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Removes every occurrence of the given names, emails, links and phone numbers. */
export function redactText(text: string, names: readonly string[] = []): string {
  let out = text.replace(EMAIL, '[email]').replace(URL_PATTERN, '[link]');
  out = out
    .replace(BARE_DOMAIN, '[link]')
    .replace(PHONE, (m) => (m.replace(/\D/g, '').length >= 9 ? '[number]' : m));
  const words = [...new Set(names.flatMap((n) => [n, ...n.split(/\s+/)]))]
    .map((n) => n.trim())
    .filter((n) => n.length >= 2)
    .sort((a, b) => b.length - a.length);
  for (const name of words) {
    out = out.replace(new RegExp(`(?<![\\w])${escapeRegExp(name)}(?![\\w])`, 'gi'), '[name]');
  }
  return out.replace(/(\[name\]\s*){2,}/g, '[name] ');
}

/**
 * The first sentence of a reply, redacted and capped, without the greeting,
 * the quoted thread under it, or the signature.
 */
export function replyExcerpt(body: string, names: readonly string[] = [], max = 160): string {
  const own: string[] = [];
  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*>/.test(line)) break;
    if (/^\s*On .+wrote:\s*$/i.test(line) || /^\s*-{2,}\s*$/.test(line)) break;
    if (/^\s*(From|Sent|To|Subject):\s/i.test(line) && own.length > 0) break;
    own.push(line);
  }

  let text = own.join(' ').replace(/\s+/g, ' ').trim();
  text = text.replace(GREETING, '').trim();
  text = redactText(text, names);

  const sentence = /^(.+?[.!?])(?:\s|$)/.exec(text)?.[1] ?? text;
  let excerpt = sentence.trim();
  if (excerpt.length > max) {
    const cut = excerpt.slice(0, max - 1);
    const space = cut.lastIndexOf(' ');
    excerpt = `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
  }
  return excerpt;
}

export interface ObjectionReply {
  readonly label: string;
  readonly reason: string;
  readonly body: string | null;
  readonly occurredAt: string;
  /** Names that must not appear: the person, their company, the sender. */
  readonly names?: readonly string[];
}

export const OBJECTION_LABELS = ['not_interested', 'question', 'referral'] as const;

/**
 * Groups classified replies by label, deterministic and model-free: the
 * classifier's reason plus a redacted first sentence, duplicates folded.
 */
export function summariseObjections(
  replies: readonly ObjectionReply[],
  options: { perGroup?: number } = {},
): BrainObjections {
  const perGroup = options.perGroup ?? 25;
  const relevant = replies.filter(
    (r) => (OBJECTION_LABELS as readonly string[]).includes(r.label) && r.reason.trim(),
  );
  const times = relevant.map((r) => r.occurredAt).sort();

  const groups: BrainObjectionGroup[] = [];
  for (const label of OBJECTION_LABELS) {
    const inLabel = relevant
      .filter((r) => r.label === label)
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
    if (inLabel.length === 0) continue;

    const seen = new Set<string>();
    const items: BrainObjectionItem[] = [];
    for (const reply of inLabel) {
      const names = reply.names ?? [];
      const reason = redactText(oneLine(reply.reason), names);
      const excerpt = reply.body ? replyExcerpt(reply.body, names) : '';
      const key = `${reason.toLowerCase()}|${excerpt.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (items.length < perGroup) items.push({ reason, excerpt });
    }
    groups.push({ label, count: inLabel.length, items });
  }

  return {
    replies: relevant.length,
    ...(times.length > 0 ? { from: times[0]!, to: times[times.length - 1]! } : {}),
    groups,
  };
}

/** Union of several campaigns' targeting, first-seen order, case-insensitive dedupe. */
export function mergeAudiences(audiences: readonly Partial<BrainAudience>[]): BrainAudience {
  const merge = (key: keyof BrainAudience): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const audience of audiences) {
      for (const value of audience[key] ?? []) {
        const trimmed = value.trim();
        if (!trimmed || seen.has(trimmed.toLowerCase())) continue;
        seen.add(trimmed.toLowerCase());
        out.push(trimmed);
      }
    }
    return out;
  };
  return {
    titles: merge('titles'),
    seniorities: merge('seniorities'),
    industries: merge('industries'),
    countries: merge('countries'),
    technologies: merge('technologies'),
    keywords: merge('keywords'),
    exclusions: merge('exclusions'),
  };
}

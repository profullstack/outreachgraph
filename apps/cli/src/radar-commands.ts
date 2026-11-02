/**
 * `og radar` — the Content Radar from a terminal.
 *
 * A client of `/api/v1/content-radar`: each product's radar (terms, audience
 * subreddits, tags, sources, auto-draft), the references it found ranked by
 * engagement with their hooks, saved collections, followed accounts, and
 * Create, which turns a reference into posts per network, a short-video
 * storyboard and an image card. The server runs all of it daily on its own;
 * this is the same by hand.
 */

import type { Command, CommandContext } from './commands';

function text(record: Record<string, unknown>, key: string, fallback = ''): string {
  const value = record[key];
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function rows(value: unknown, key: string): readonly Record<string, unknown>[] {
  const list = (value as Record<string, unknown>)[key];
  return Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
}

function flagString(flags: CommandContext['flags'], key: string): string | undefined {
  const value = flags[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function csv(value: string | undefined): string[] | undefined {
  return value
    ? value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
    : undefined;
}

export const RADAR_USAGE = [
  'og radar                                   every product radar',
  'og radar set <offeringId> [--terms a,b] [--subreddits a,b] [--tags a,b] [--sources hackernews,bluesky,devto,mastodon,reddit] [--to linkedin,bluesky,x] [--auto on|off] [--on|--off]',
  'og radar scan <offeringId>                 read every source now',
  'og radar refs [--product <id>] [--source s] [--hook h] [--status new|saved|used|dismissed] [--collection c] [--recent] [--limit n]',
  'og radar add <url> [--product <id>] [--collection c] [--text "post text"]',
  'og radar save <refId> [--collection "Hooks to try"] | dismiss <refId>',
  'og radar create <refId> [--product <id>] [--to linkedin,x] [--formats posts,storyboard,image]',
  'og radar follows | follow <bluesky|mastodon|hackernews|reddit|devto> <handle> [--product <id>] [--label l] | unfollow <followId>',
  'og radar assets [--product <id>]',
].join('\n');

function referenceLine(ref: Record<string, unknown>): string {
  const hook = (ref.hook ?? {}) as Record<string, unknown>;
  const label = hook.label ? `${text(hook, 'label')}${hook.judged ? '' : '?'}` : '-';
  const head = (text(ref, 'title') || text(ref, 'text')).replace(/\s+/g, ' ').slice(0, 90);
  return [
    `${text(ref, 'id')}  ${text(ref, 'source')}  ${text(ref, 'engagement')}  [${label}]  ${head}`,
    hook.why ? `   why: ${text(hook, 'why')}` : '',
    hook.angle ? `   angle: ${text(hook, 'angle')}` : '',
    `   ${text(ref, 'url')}${ref.collection ? `  (${text(ref, 'collection')})` : ''}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function assetBlock(asset: Record<string, unknown>): string {
  if (asset.kind === 'storyboard') {
    const board = (asset.storyboard ?? {}) as Record<string, unknown>;
    const scenes = rows(board, 'scenes');
    return [
      `${text(asset, 'id')}  storyboard  ${text(board, 'title')}`,
      ...scenes.map(
        (s, i) =>
          `  ${i + 1}. ${text(s, 'beat')} (${text(s, 'seconds')}s) "${text(s, 'onScreen')}" - ${text(s, 'voiceover')} [${text(s, 'shot')}]`,
      ),
      board.caption ? `  caption: ${text(board, 'caption')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  const image = (asset.image ?? {}) as Record<string, unknown>;
  return [
    `${text(asset, 'id')}  image  ${text(image, 'headline')}`,
    `  ${text(image, 'support')}`,
    `  svg: /api/v1${text(asset, 'imagePath')}`,
  ].join('\n');
}

async function runRadar({ client, args, flags }: CommandContext): Promise<string> {
  const [verb = 'list', first, second] = args;
  const json = flags.json === true;

  if (verb === 'list' || verb === 'ls') {
    const result = await client.get('/content-radar');
    if (json) return JSON.stringify(result, null, 2);
    const radars = rows(result, 'radars');
    if (radars.length === 0) return 'No products yet. Add one: og products add <url>';
    return radars
      .map((r) =>
        [
          `${text(r, 'offeringId')}  ${text(r, 'name')}  ${r.enabled ? 'on' : 'off'}  auto-draft ${r.autoDraft ? 'on' : 'off'}  ${text(r, 'references')} refs`,
          `  terms: ${((r.terms as string[]) ?? []).join(', ') || '-'}`,
          `  subreddits: ${((r.subreddits as string[]) ?? []).join(', ') || '-'}  tags: ${((r.tags as string[]) ?? []).join(', ') || '-'}`,
          `  posts to: ${((r.networks as string[]) ?? []).join(', ')}  last scan: ${text(r, 'lastScanAt', 'never')}${r.lastError ? `  (${text(r, 'lastError')})` : ''}`,
        ].join('\n'),
      )
      .join('\n\n');
  }

  if (verb === 'set') {
    if (!first) throw new Error(RADAR_USAGE);
    const auto = flagString(flags, 'auto');
    const body = {
      ...(csv(flagString(flags, 'terms')) ? { terms: csv(flagString(flags, 'terms')) } : {}),
      ...(csv(flagString(flags, 'subreddits'))
        ? { subreddits: csv(flagString(flags, 'subreddits')) }
        : {}),
      ...(csv(flagString(flags, 'tags')) ? { tags: csv(flagString(flags, 'tags')) } : {}),
      ...(csv(flagString(flags, 'sources')) ? { sources: csv(flagString(flags, 'sources')) } : {}),
      ...(csv(flagString(flags, 'to')) ? { networks: csv(flagString(flags, 'to')) } : {}),
      ...(auto ? { autoDraft: auto === 'on' || auto === 'true' } : {}),
      ...(flags.on === true ? { enabled: true } : {}),
      ...(flags.off === true ? { enabled: false } : {}),
    };
    const { radar } = (await client.put(
      `/content-radar/radars/${encodeURIComponent(first)}`,
      body,
    )) as { radar: Record<string, unknown> };
    return `${text(radar, 'name')}: terms ${((radar.terms as string[]) ?? []).join(', ')}; auto-draft ${radar.autoDraft ? 'on' : 'off'}`;
  }

  if (verb === 'scan') {
    if (!first) throw new Error('og radar scan <offeringId>');
    const { result } = (await client.post(
      `/content-radar/radars/${encodeURIComponent(first)}/scan`,
      {},
    )) as { result: Record<string, unknown> };
    const failures = rows(result, 'failures');
    return `read ${text(result, 'read')}, ${text(result, 'stored')} new, ${text(result, 'judged')} hooks named${
      failures.length ? `; failed: ${failures.map((f) => text(f, 'source')).join(', ')}` : ''
    }. See: og radar refs --product ${first}`;
  }

  if (verb === 'refs' || verb === 'references') {
    const result = await client.get('/content-radar/references', {
      offeringId: flagString(flags, 'product'),
      source: flagString(flags, 'source'),
      hook: flagString(flags, 'hook'),
      status: flagString(flags, 'status'),
      collection: flagString(flags, 'collection'),
      sort: flags.recent === true ? 'recent' : flagString(flags, 'sort'),
      limit: flagString(flags, 'limit') ?? '25',
    });
    if (json) return JSON.stringify(result, null, 2);
    const refs = rows(result, 'references');
    return refs.length
      ? refs.map(referenceLine).join('\n')
      : 'No references yet: og radar scan <offeringId>';
  }

  if (verb === 'add') {
    if (!first)
      throw new Error('og radar add <url> [--product <id>] [--collection c] [--text "..."]');
    const { reference } = (await client.post('/content-radar/references', {
      url: first,
      ...(flagString(flags, 'product') ? { offeringId: flagString(flags, 'product') } : {}),
      ...(flagString(flags, 'collection') ? { collection: flagString(flags, 'collection') } : {}),
      ...(flagString(flags, 'text') ? { text: flagString(flags, 'text') } : {}),
    })) as { reference: Record<string, unknown> };
    return referenceLine(reference);
  }

  if (verb === 'save' || verb === 'dismiss' || verb === 'restore') {
    if (!first) throw new Error(`og radar ${verb} <refId>`);
    if (!client.patch) throw new Error('this client cannot edit references');
    const body =
      verb === 'save'
        ? {
            status: 'saved',
            ...(flagString(flags, 'collection')
              ? { collection: flagString(flags, 'collection') }
              : {}),
          }
        : { status: verb === 'dismiss' ? 'dismissed' : 'new' };
    const { reference } = (await client.patch(
      `/content-radar/references/${encodeURIComponent(first)}`,
      body,
    )) as { reference: Record<string, unknown> };
    return `${text(reference, 'id')} ${text(reference, 'status')}${reference.collection ? ` in ${text(reference, 'collection')}` : ''}`;
  }

  if (verb === 'create') {
    if (!first)
      throw new Error(
        'og radar create <refId> [--product <id>] [--to a,b] [--formats posts,storyboard,image]',
      );
    const result = (await client.post(
      `/content-radar/references/${encodeURIComponent(first)}/create`,
      {
        ...(flagString(flags, 'product') ? { offeringId: flagString(flags, 'product') } : {}),
        ...(csv(flagString(flags, 'to')) ? { networks: csv(flagString(flags, 'to')) } : {}),
        ...(csv(flagString(flags, 'formats'))
          ? { formats: csv(flagString(flags, 'formats')) }
          : {}),
      },
    )) as Record<string, unknown>;
    if (json) return JSON.stringify(result, null, 2);
    const skipped = Array.isArray(result.skipped) ? (result.skipped as string[]) : [];
    return [
      result.batchId
        ? `${text(result, 'posts')} posts drafted (batch ${text(result, 'batchId')}). See: og linkpost list`
        : 'No posts drafted.',
      ...rows(result, 'assets').map(assetBlock),
      ...skipped.map((s) => `skipped ${s}`),
    ].join('\n\n');
  }

  if (verb === 'follows') {
    const result = await client.get('/content-radar/follows');
    const follows = rows(result, 'follows');
    return follows.length
      ? follows
          .map(
            (f) =>
              `${text(f, 'id')}  ${text(f, 'network')}  ${text(f, 'handle')}  ${text(f, 'kind')}${f.label ? `  "${text(f, 'label')}"` : ''}  read ${text(f, 'lastReadAt', 'never')}${f.lastError ? ` (${text(f, 'lastError')})` : ''}`,
          )
          .join('\n')
      : 'Not following anyone. og radar follow bluesky <handle> --label Rival';
  }

  if (verb === 'follow') {
    if (!first || !second)
      throw new Error('og radar follow <network> <handle> [--product <id>] [--label l]');
    const { follow } = (await client.post('/content-radar/follows', {
      network: first,
      handle: second,
      ...(flagString(flags, 'product') ? { offeringId: flagString(flags, 'product') } : {}),
      ...(flagString(flags, 'label') ? { label: flagString(flags, 'label') } : {}),
      ...(flagString(flags, 'kind') ? { kind: flagString(flags, 'kind') } : {}),
    })) as { follow: Record<string, unknown> };
    return `${text(follow, 'id')} following ${text(follow, 'handle')} on ${text(follow, 'network')}; read on the next scan`;
  }

  if (verb === 'unfollow') {
    if (!first) throw new Error('og radar unfollow <followId>');
    if (!client.delete) throw new Error('this client cannot delete');
    await client.delete(`/content-radar/follows/${encodeURIComponent(first)}`);
    return `${first} removed`;
  }

  if (verb === 'assets') {
    const result = await client.get('/content-radar/assets', {
      offeringId: flagString(flags, 'product'),
    });
    if (json) return JSON.stringify(result, null, 2);
    const assets = rows(result, 'assets');
    return assets.length
      ? assets.map(assetBlock).join('\n\n')
      : 'No storyboards or image cards yet.';
  }

  throw new Error(RADAR_USAGE);
}

export const RADAR_COMMANDS: readonly Command[] = [
  {
    name: 'radar',
    usage: RADAR_USAGE,
    summary:
      'Content Radar: what gets attention in your niche, why it works, and posts, storyboards and image cards made from it.',
    run: runRadar,
  },
];

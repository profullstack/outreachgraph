'use client';

/**
 * The Content Radar in the browser: Discover (what got attention in the
 * product's niche, with the hook and why it worked), Saved (collections),
 * Following (competitors and creators), and Studio (storyboards and image
 * cards). Everything here also runs on its own daily on the server; this is
 * where a person looks, steers and creates by hand.
 */

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

type Source = 'hackernews' | 'bluesky' | 'devto' | 'mastodon' | 'reddit' | 'manual';

interface Radar {
  offeringId: string;
  name: string;
  url?: string;
  terms: string[];
  subreddits: string[];
  tags: string[];
  sources: Source[];
  networks: string[];
  enabled: boolean;
  autoDraft: boolean;
  lastScanAt?: string;
  lastError?: string;
  references: number;
}

interface Reference {
  id: string;
  offeringId?: string;
  source: Source;
  url: string;
  authorHandle?: string;
  authorName?: string;
  title?: string;
  text: string;
  container?: string;
  postedAt: string;
  likes: number;
  reposts: number;
  comments: number;
  engagement: number;
  lift?: number;
  relevant?: boolean;
  origin: 'keyword' | 'follow' | 'manual';
  matched?: string;
  hook?: { type: string; label: string; why?: string; angle?: string; judged: boolean };
  status: 'new' | 'saved' | 'used' | 'dismissed';
  collection?: string;
}

interface Follow {
  id: string;
  network: string;
  handle: string;
  label?: string;
  kind: string;
  lastReadAt?: string;
  lastError?: string;
}

interface Scene {
  beat: string;
  onScreen: string;
  voiceover: string;
  shot: string;
  seconds: number;
}

type Asset =
  | {
      id: string;
      kind: 'storyboard';
      title: string;
      storyboard: { title: string; caption: string; scenes: Scene[] };
      createdAt: string;
      linkBatchId?: string;
    }
  | {
      id: string;
      kind: 'image';
      title: string;
      image: {
        headline: string;
        support: string;
        caption: string;
        eyebrow: string;
        footer: string;
      };
      imagePath: string;
      createdAt: string;
      linkBatchId?: string;
    };

const SOURCE_LABELS: Record<Source, string> = {
  hackernews: 'Hacker News',
  bluesky: 'Bluesky',
  devto: 'dev.to',
  mastodon: 'Mastodon',
  reddit: 'Reddit',
  manual: 'Saved link',
};

const TABS = [
  ['discover', 'Discover'],
  ['saved', 'Saved'],
  ['following', 'Following'],
  ['studio', 'Studio'],
] as const;
export type RadarTab = (typeof TABS)[number][0];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1/content-radar${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message ?? `request failed (${response.status})`);
  return body;
}

function ago(iso?: string): string {
  if (!iso) return 'never';
  const hours = (Date.now() - Date.parse(iso)) / 3_600_000;
  if (hours < 1) return 'just now';
  if (hours < 48) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function ContentRadar({ tab }: { tab: RadarTab }) {
  const [radars, setRadars] = useState<Radar[]>([]);
  const [hookTypes, setHookTypes] = useState<{ type: string; label: string }[]>([]);
  const [drafting, setDrafting] = useState(false);
  const [offeringId, setOfferingId] = useState('');
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{
      radars: Radar[];
      draftingEnabled: boolean;
      hookTypes: { type: string; label: string }[];
    }>('')
      .then((body) => {
        setRadars(body.radars);
        setHookTypes(body.hookTypes);
        setDrafting(body.draftingEnabled);
        setOfferingId((current) => current || body.radars[0]?.offeringId || '');
      })
      .catch((caught: Error) => setError(caught.message))
      .finally(() => setLoading(false));
  }, []);

  const radar = radars.find((r) => r.offeringId === offeringId);

  return (
    <div className="space-y-4">
      <nav className="border-border flex gap-2 overflow-x-auto border-b pb-2 text-sm">
        {TABS.map(([value, label]) => (
          <Link
            key={value}
            href={`/content?tab=${value}`}
            aria-current={tab === value ? 'page' : undefined}
            className={`shrink-0 rounded-full border px-3 py-1.5 ${
              tab === value ? 'border-accent bg-accent text-white' : 'border-border text-ink-muted'
            }`}
          >
            {label}
          </Link>
        ))}
        <Link
          href="/content?tab=drafts"
          className="border-border text-ink-muted shrink-0 rounded-full border px-3 py-1.5"
        >
          Drafts
        </Link>
      </nav>

      {radars.length > 1 && tab !== 'following' ? (
        <label className="text-ink-muted block text-xs">
          Product
          <select
            value={offeringId}
            onChange={(event) => setOfferingId(event.target.value)}
            className="border-border bg-surface mt-1 block w-full rounded-xl border px-3 py-2.5 text-sm text-ink"
          >
            {radars.map((r) => (
              <option key={r.offeringId} value={r.offeringId}>
                {r.name} · {r.references} references
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {error ? (
        <p role="alert" className="text-hot text-sm">
          {error}
        </p>
      ) : null}
      {loading ? <p className="text-ink-muted text-sm">Loading the radar…</p> : null}
      {!loading && radars.length === 0 ? (
        <p className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
          Add a product first; its radar starts on its own.
        </p>
      ) : null}

      {radar && tab === 'discover' ? (
        <Discover
          radar={radar}
          hookTypes={hookTypes}
          drafting={drafting}
          onRadar={(next) =>
            setRadars((all) => all.map((r) => (r.offeringId === next.offeringId ? next : r)))
          }
        />
      ) : null}
      {radar && tab === 'saved' ? (
        <Saved radar={radar} hookTypes={hookTypes} drafting={drafting} />
      ) : null}
      {tab === 'following' && !loading ? <Following radars={radars} /> : null}
      {radar && tab === 'studio' ? <Studio offeringId={radar.offeringId} /> : null}
    </div>
  );
}

/* ---------------------------------------------------------------- discover */

function Discover({
  radar,
  hookTypes,
  drafting,
  onRadar,
}: {
  radar: Radar;
  hookTypes: { type: string; label: string }[];
  drafting: boolean;
  onRadar: (radar: Radar) => void;
}) {
  const [origin, setOrigin] = useState<'' | 'keyword' | 'follow'>('');
  const [source, setSource] = useState('');
  const [hook, setHook] = useState('');
  const [sort, setSort] = useState<'lift' | 'engagement' | 'recent'>('lift');
  const [refs, setRefs] = useState<Reference[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);

  const load = useCallback(async () => {
    const query = new URLSearchParams({ offeringId: radar.offeringId, sort, limit: '80' });
    if (origin) query.set('origin', origin);
    if (source) query.set('source', source);
    if (hook) query.set('hook', hook);
    const body = await api<{ references: Reference[] }>(`/references?${query.toString()}`);
    setRefs(body.references);
  }, [radar.offeringId, origin, source, hook, sort]);

  useEffect(() => {
    void load().catch((caught: Error) => setMessage(caught.message));
  }, [load]);

  async function scan(): Promise<void> {
    setBusy(true);
    setMessage('Reading Hacker News, Bluesky, dev.to, Mastodon and Reddit…');
    try {
      const { result } = await api<{
        result: { read: number; stored: number; judged: number; failures: { source: string }[] };
      }>(`/radars/${radar.offeringId}/scan`, { method: 'POST', body: '{}' });
      setMessage(
        `Read ${result.read} posts, ${result.stored} new, ${result.judged} hooks named` +
          (result.failures.length
            ? `. Could not read: ${result.failures.map((f) => f.source).join(', ')}`
            : ''),
      );
      await load();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'scan failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="border-border bg-surface-raised rounded-2xl border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">Find your next post for {radar.name}</h2>
            <p className="text-ink-muted text-xs">
              Scanned {ago(radar.lastScanAt)} · runs daily ·{' '}
              {radar.autoDraft
                ? 'drafts its best find each day on its own'
                : 'auto-drafting is off'}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setSettingsOpen((open) => !open)}
              className="border-border rounded-lg border px-3 py-2 text-xs"
            >
              {settingsOpen ? 'Close settings' : 'Radar settings'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void scan()}
              className="bg-accent rounded-lg px-3 py-2 text-xs font-medium text-white disabled:opacity-60"
            >
              {busy ? 'Scanning…' : 'Scan now'}
            </button>
          </div>
        </div>
        {settingsOpen ? <RadarSettings radar={radar} onSaved={onRadar} /> : null}
        {radar.lastError ? (
          <p className="text-ink-muted mt-2 text-[11px]">Last run: {radar.lastError}</p>
        ) : null}
        <AddReference offeringId={radar.offeringId} onAdded={() => void load()} />
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        {(
          [
            ['', 'All'],
            ['keyword', 'For you'],
            ['follow', 'Following'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={label}
            type="button"
            aria-pressed={origin === value}
            onClick={() => setOrigin(value)}
            className={`rounded-full border px-3 py-1.5 ${
              origin === value
                ? 'border-accent bg-accent text-white'
                : 'border-border text-ink-muted'
            }`}
          >
            {label}
          </button>
        ))}
        <select
          aria-label="Platform"
          value={source}
          onChange={(event) => setSource(event.target.value)}
          className="border-border bg-surface rounded-full border px-3 py-1.5"
        >
          <option value="">All platforms</option>
          {(['hackernews', 'bluesky', 'devto', 'mastodon', 'reddit'] as const).map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABELS[s]}
            </option>
          ))}
        </select>
        <select
          aria-label="Hook"
          value={hook}
          onChange={(event) => setHook(event.target.value)}
          className="border-border bg-surface rounded-full border px-3 py-1.5"
        >
          <option value="">All hooks</option>
          {hookTypes.map((h) => (
            <option key={h.type} value={h.type}>
              {h.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Sort"
          value={sort}
          onChange={(event) => setSort(event.target.value as 'lift' | 'engagement' | 'recent')}
          className="border-border bg-surface rounded-full border px-3 py-1.5"
        >
          <option value="lift">Stand-outs</option>
          <option value="engagement">Most engaging</option>
          <option value="recent">Newest</option>
        </select>
      </div>

      {message ? (
        <p aria-live="polite" className="text-ink-muted text-xs">
          {message}
        </p>
      ) : null}

      <ReferenceList
        refs={refs}
        drafting={drafting}
        onChange={(ref) =>
          setRefs((all) =>
            ref.status === 'dismissed' || ref.status === 'used'
              ? all.filter((r) => r.id !== ref.id)
              : all.map((r) => (r.id === ref.id ? ref : r)),
          )
        }
        empty="Nothing yet. Press Scan now, or wait for the daily run."
      />
    </div>
  );
}

function RadarSettings({ radar, onSaved }: { radar: Radar; onSaved: (radar: Radar) => void }) {
  const [terms, setTerms] = useState(radar.terms.join(', '));
  const [subreddits, setSubreddits] = useState(radar.subreddits.join(', '));
  const [tags, setTags] = useState(radar.tags.join(', '));
  const [networks, setNetworks] = useState(radar.networks.join(', '));
  const [autoDraft, setAutoDraft] = useState(radar.autoDraft);
  const [enabled, setEnabled] = useState(radar.enabled);
  const [message, setMessage] = useState('');
  const split = (value: string) =>
    value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    try {
      const { radar: next } = await api<{ radar: Radar }>(`/radars/${radar.offeringId}`, {
        method: 'PUT',
        body: JSON.stringify({
          terms: split(terms),
          subreddits: split(subreddits),
          tags: split(tags),
          networks: split(networks),
          autoDraft,
          enabled,
        }),
      });
      onSaved({ ...radar, ...next, references: radar.references });
      setMessage('Saved. The next scan uses these.');
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'could not save');
    }
  }

  const field = 'border-border bg-surface mt-1 w-full rounded-xl border px-3 py-2 text-sm text-ink';
  return (
    <form onSubmit={(event) => void save(event)} className="mt-3 grid gap-3 sm:grid-cols-2">
      <label className="text-ink-muted block text-xs">
        Terms (searched on Hacker News and Bluesky)
        <input value={terms} onChange={(e) => setTerms(e.target.value)} className={field} />
      </label>
      <label className="text-ink-muted block text-xs">
        Audience subreddits
        <input
          value={subreddits}
          onChange={(e) => setSubreddits(e.target.value)}
          placeholder="getdisciplined, productivity"
          className={field}
        />
      </label>
      <label className="text-ink-muted block text-xs">
        Tags (dev.to and Mastodon)
        <input value={tags} onChange={(e) => setTags(e.target.value)} className={field} />
      </label>
      <label className="text-ink-muted block text-xs">
        Draft posts for
        <input value={networks} onChange={(e) => setNetworks(e.target.value)} className={field} />
      </label>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={autoDraft}
          onChange={(e) => setAutoDraft(e.target.checked)}
        />
        Draft from the best find every day on its own
      </label>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Radar on
      </label>
      <div className="flex items-center gap-3 sm:col-span-2">
        <button
          type="submit"
          className="bg-accent rounded-lg px-3 py-2 text-xs font-medium text-white"
        >
          Save settings
        </button>
        {message ? <span className="text-ink-muted text-xs">{message}</span> : null}
      </div>
    </form>
  );
}

function AddReference({ offeringId, onAdded }: { offeringId: string; onAdded: () => void }) {
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function add(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      await api('/references', {
        method: 'POST',
        body: JSON.stringify({ url, offeringId, ...(text.trim() ? { text: text.trim() } : {}) }),
      });
      setUrl('');
      setText('');
      setMessage('Saved to references.');
      onAdded();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'could not add it');
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="mt-3">
      <summary className="text-accent cursor-pointer text-xs">Add a reference by link</summary>
      <form onSubmit={(event) => void add(event)} className="mt-2 space-y-2">
        <input
          required
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.tiktok.com/@someone/video/123"
          className="border-border bg-surface w-full rounded-xl border px-3 py-2 text-sm text-ink"
        />
        <textarea
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste the post text if the page needs a login (TikTok, Instagram, X)"
          className="border-border bg-surface w-full rounded-xl border px-3 py-2 text-sm text-ink"
        />
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={busy}
            className="border-border rounded-lg border px-3 py-2 text-xs disabled:opacity-60"
          >
            {busy ? 'Saving…' : 'Add reference'}
          </button>
          {message ? <span className="text-ink-muted text-xs">{message}</span> : null}
        </div>
      </form>
    </details>
  );
}

/* ------------------------------------------------------------------- saved */

function Saved({
  radar,
  drafting,
}: {
  radar: Radar;
  hookTypes: { type: string; label: string }[];
  drafting: boolean;
}) {
  const [collection, setCollection] = useState('');
  const [collections, setCollections] = useState<{ name: string; count: number }[]>([]);
  const [refs, setRefs] = useState<Reference[]>([]);

  useEffect(() => {
    const query = new URLSearchParams({ offeringId: radar.offeringId, status: 'saved' });
    if (collection) query.set('collection', collection);
    void api<{ references: Reference[]; collections: { name: string; count: number }[] }>(
      `/references?${query.toString()}`,
    ).then((body) => {
      setRefs(body.references);
      setCollections(body.collections);
    });
  }, [radar.offeringId, collection]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 text-xs">
        {[{ name: '', count: 0 }, ...collections].map((c) => (
          <button
            key={c.name || 'all'}
            type="button"
            aria-pressed={collection === c.name}
            onClick={() => setCollection(c.name)}
            className={`rounded-full border px-3 py-1.5 ${
              collection === c.name
                ? 'border-accent bg-accent text-white'
                : 'border-border text-ink-muted'
            }`}
          >
            {c.name ? `${c.name} · ${c.count}` : 'All saved'}
          </button>
        ))}
      </div>
      <ReferenceList
        refs={refs}
        drafting={drafting}
        onChange={(ref) =>
          setRefs((all) =>
            ref.status === 'saved'
              ? all.map((r) => (r.id === ref.id ? ref : r))
              : all.filter((r) => r.id !== ref.id),
          )
        }
        empty="Save references from Discover; saved ones are drafted from first."
      />
    </div>
  );
}

/* ------------------------------------------------------------ reference card */

function ReferenceList({
  refs,
  drafting,
  onChange,
  empty,
}: {
  refs: Reference[];
  drafting: boolean;
  onChange: (ref: Reference) => void;
  empty: string;
}) {
  if (refs.length === 0) {
    return (
      <p className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
        {empty}
      </p>
    );
  }
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {refs.map((ref) => (
        <ReferenceCard key={ref.id} reference={ref} drafting={drafting} onChange={onChange} />
      ))}
    </div>
  );
}

function ReferenceCard({
  reference,
  drafting,
  onChange,
}: {
  reference: Reference;
  drafting: boolean;
  onChange: (ref: Reference) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [formats, setFormats] = useState<Record<'posts' | 'storyboard' | 'image', boolean>>({
    posts: true,
    storyboard: true,
    image: true,
  });

  async function patch(body: Record<string, unknown>, done: string): Promise<void> {
    setBusy(true);
    try {
      const { reference: next } = await api<{ reference: Reference }>(
        `/references/${reference.id}`,
        { method: 'PATCH', body: JSON.stringify(body) },
      );
      setMessage(done);
      onChange(next);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'could not save');
    } finally {
      setBusy(false);
    }
  }

  async function create(): Promise<void> {
    setBusy(true);
    setMessage('Writing posts, a storyboard and an image card…');
    try {
      const picked = (Object.keys(formats) as (keyof typeof formats)[]).filter((k) => formats[k]);
      const result = await api<{ posts: number; assets: Asset[]; skipped: string[] }>(
        `/references/${reference.id}/create`,
        { method: 'POST', body: JSON.stringify({ formats: picked }) },
      );
      setMessage(
        [
          result.posts ? `${result.posts} posts in Manual posts` : '',
          result.assets.length ? `${result.assets.length} in Studio` : '',
          ...result.skipped,
        ]
          .filter(Boolean)
          .join(' · '),
      );
      onChange({ ...reference, status: 'used' });
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'could not create');
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="border-border bg-surface-raised flex flex-col rounded-2xl border p-4">
      <p className="text-ink-muted text-[11px] font-medium uppercase">
        {SOURCE_LABELS[reference.source] ?? reference.source}
        {reference.container ? ` · ${reference.container}` : ''}
        {reference.authorHandle ? ` · ${reference.authorName ?? reference.authorHandle}` : ''}
      </p>
      {reference.title ? <h3 className="mt-1 text-sm font-semibold">{reference.title}</h3> : null}
      <p className="mt-1 line-clamp-5 text-sm leading-relaxed whitespace-pre-line">
        {reference.title && reference.text.startsWith(reference.title)
          ? reference.text.slice(reference.title.length).trim()
          : reference.text}
      </p>
      <p className="text-ink-muted mt-2 text-xs">
        {reference.likes} likes · {reference.reposts} reposts · {reference.comments} comments ·{' '}
        {ago(reference.postedAt)}
        {reference.matched ? ` · ${reference.matched}` : ''}
        {reference.lift && reference.lift >= 1.5 ? (
          <span className="text-accent font-semibold"> · {reference.lift}x its peers</span>
        ) : null}
        {reference.relevant === false ? ' · off-topic' : ''}
      </p>
      {reference.hook ? (
        <div className="border-border mt-3 rounded-xl border p-3">
          <p className="text-accent text-xs font-semibold">
            {reference.hook.label}
            {reference.hook.judged ? '' : ' (from the wording)'}
          </p>
          {reference.hook.why ? <p className="mt-1 text-xs">{reference.hook.why}</p> : null}
          {reference.hook.angle ? (
            <p className="text-ink-muted mt-1 text-xs">Your angle: {reference.hook.angle}</p>
          ) : null}
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-3 text-[11px]">
        {(['posts', 'storyboard', 'image'] as const).map((format) => (
          <label key={format} className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={formats[format]}
              onChange={(e) => setFormats((f) => ({ ...f, [format]: e.target.checked }))}
            />
            {format === 'posts'
              ? 'Posts'
              : format === 'storyboard'
                ? 'Video storyboard'
                : 'Image card'}
          </label>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || !drafting}
          onClick={() => void create()}
          className="bg-accent rounded-lg px-3 py-2 text-xs font-medium text-white disabled:opacity-60"
          title={drafting ? undefined : 'No model is configured'}
        >
          Create for my product
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            const name = window.prompt('Collection', reference.collection ?? 'Hooks to try');
            if (name !== null) void patch({ status: 'saved', collection: name || null }, 'Saved');
          }}
          className="border-border rounded-lg border px-3 py-2 text-xs"
        >
          {reference.status === 'saved' ? 'Move' : 'Save'}
        </button>
        <a
          href={reference.url}
          target="_blank"
          rel="noreferrer"
          className="border-border rounded-lg border px-3 py-2 text-xs"
        >
          Open
        </a>
        <button
          type="button"
          disabled={busy}
          onClick={() => void patch({ status: 'dismissed' }, 'Dismissed')}
          className="text-ink-muted rounded-lg px-2 py-2 text-xs"
        >
          Dismiss
        </button>
      </div>
      {message ? (
        <p aria-live="polite" className="text-ink-muted mt-2 text-xs">
          {message}{' '}
          {message.includes('Manual posts') ? (
            <Link className="text-accent underline" href="/approvals?tab=handoffs">
              Open
            </Link>
          ) : null}
        </p>
      ) : null}
    </article>
  );
}

/* --------------------------------------------------------------- following */

function Following({ radars }: { radars: Radar[] }) {
  const [follows, setFollows] = useState<Follow[]>([]);
  const [network, setNetwork] = useState('bluesky');
  const [handle, setHandle] = useState('');
  const [label, setLabel] = useState('');
  const [offeringId, setOfferingId] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    void api<{ follows: Follow[] }>('/follows').then((body) => setFollows(body.follows));
  }, []);

  async function add(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    try {
      const { follow } = await api<{ follow: Follow }>('/follows', {
        method: 'POST',
        body: JSON.stringify({
          network,
          handle,
          ...(label.trim() ? { label: label.trim() } : {}),
          ...(offeringId ? { offeringId } : {}),
        }),
      });
      setFollows((all) => [follow, ...all]);
      setHandle('');
      setLabel('');
      setMessage('Following. Their posts arrive with the next scan.');
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'could not follow');
    }
  }

  async function remove(id: string): Promise<void> {
    await api(`/follows/${id}`, { method: 'DELETE' });
    setFollows((all) => all.filter((f) => f.id !== id));
  }

  const field = 'border-border bg-surface rounded-xl border px-3 py-2 text-sm text-ink';
  return (
    <div className="space-y-3">
      <form
        onSubmit={(event) => void add(event)}
        className="border-border bg-surface-raised grid gap-2 rounded-2xl border p-4 sm:grid-cols-5"
      >
        <select value={network} onChange={(e) => setNetwork(e.target.value)} className={field}>
          <option value="bluesky">Bluesky</option>
          <option value="mastodon">Mastodon</option>
          <option value="hackernews">Hacker News</option>
          <option value="reddit">Reddit</option>
          <option value="devto">dev.to</option>
        </select>
        <input
          required
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          placeholder="handle or profile URL"
          className={`${field} sm:col-span-2`}
        />
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="label, e.g. TallyDay"
          className={field}
        />
        <select
          value={offeringId}
          onChange={(e) => setOfferingId(e.target.value)}
          className={field}
        >
          <option value="">Every product</option>
          {radars.map((r) => (
            <option key={r.offeringId} value={r.offeringId}>
              {r.name}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-3 sm:col-span-5">
          <button
            type="submit"
            className="bg-accent rounded-lg px-3 py-2 text-xs font-medium text-white"
          >
            Follow
          </button>
          <span className="text-ink-muted text-xs">
            {message ||
              'Competitors and creators whose posts every scan reads. TikTok, Instagram and X need a login, so add those posts by link in Discover.'}
          </span>
        </div>
      </form>
      {follows.length ? (
        <ul className="border-border divide-border divide-y rounded-2xl border">
          {follows.map((f) => (
            <li key={f.id} className="flex items-center justify-between gap-3 p-3 text-sm">
              <span className="min-w-0 truncate">
                <span className="font-medium">{f.label ?? f.handle}</span>{' '}
                <span className="text-ink-muted text-xs">
                  {f.network} · @{f.handle} · read {ago(f.lastReadAt)}
                  {f.lastError ? ` · ${f.lastError}` : ''}
                </span>
              </span>
              <button
                type="button"
                onClick={() => void remove(f.id)}
                className="text-hot shrink-0 text-xs"
              >
                Unfollow
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ studio */

function Studio({ offeringId }: { offeringId: string }) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void api<{ assets: Asset[] }>(`/assets?offeringId=${encodeURIComponent(offeringId)}`)
      .then((body) => setAssets(body.assets))
      .finally(() => setLoaded(true));
  }, [offeringId]);

  async function remove(id: string): Promise<void> {
    await api(`/assets/${id}`, { method: 'DELETE' });
    setAssets((all) => all.filter((a) => a.id !== id));
  }

  if (loaded && assets.length === 0) {
    return (
      <p className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
        Storyboards and image cards made from references show up here. The posts go to{' '}
        <Link className="text-accent underline" href="/approvals?tab=handoffs">
          Manual posts
        </Link>
        .
      </p>
    );
  }
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {assets.map((asset) =>
        asset.kind === 'image' ? (
          <ImageAsset key={asset.id} asset={asset} onDelete={() => void remove(asset.id)} />
        ) : (
          <article
            key={asset.id}
            className="border-border bg-surface-raised rounded-2xl border p-4"
          >
            <p className="text-ink-muted text-[11px] font-medium uppercase">
              Short video · Reels and TikTok ·{' '}
              {asset.storyboard.scenes.reduce((sum, s) => sum + s.seconds, 0)}s
            </p>
            <h3 className="mt-1 text-sm font-semibold">{asset.storyboard.title}</h3>
            <ol className="mt-2 space-y-2">
              {asset.storyboard.scenes.map((scene, i) => (
                <li key={i} className="border-border rounded-xl border p-2 text-xs">
                  <p className="font-semibold">
                    {String(i + 1).padStart(2, '0')} {scene.beat} · {scene.seconds}s · “
                    {scene.onScreen}”
                  </p>
                  <p className="mt-0.5">{scene.voiceover}</p>
                  <p className="text-ink-muted mt-0.5">Shot: {scene.shot}</p>
                </li>
              ))}
            </ol>
            {asset.storyboard.caption ? (
              <p className="text-ink-muted mt-2 text-xs">Caption: {asset.storyboard.caption}</p>
            ) : null}
            <div className="mt-2 flex gap-2">
              <CopyButton
                text={[
                  asset.storyboard.title,
                  ...asset.storyboard.scenes.map(
                    (s, i) =>
                      `${i + 1}. [${s.beat}, ${s.seconds}s] "${s.onScreen}" ${s.voiceover} (${s.shot})`,
                  ),
                  asset.storyboard.caption,
                ].join('\n')}
              />
              <button
                type="button"
                onClick={() => void remove(asset.id)}
                className="text-hot text-xs"
              >
                Delete
              </button>
            </div>
          </article>
        ),
      )}
    </div>
  );
}

function ImageAsset({
  asset,
  onDelete,
}: {
  asset: Extract<Asset, { kind: 'image' }>;
  onDelete: () => void;
}) {
  const src = useMemo(() => `/api/v1${asset.imagePath}`, [asset.imagePath]);

  async function downloadPng(): Promise<void> {
    const svg = await (await fetch(src, { credentials: 'same-origin' })).text();
    const image = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('could not render'));
      image.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = 1080;
    canvas.height = 1350;
    canvas.getContext('2d')?.drawImage(image, 0, 0, 1080, 1350);
    URL.revokeObjectURL(url);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `${asset.id}.png`;
      link.click();
    }, 'image/png');
  }

  return (
    <article className="border-border bg-surface-raised rounded-2xl border p-4">
      <p className="text-ink-muted text-[11px] font-medium uppercase">Image card · 1080×1350</p>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={asset.image.headline} className="mt-2 w-full rounded-xl" />
      {asset.image.caption ? <p className="mt-2 text-xs">{asset.image.caption}</p> : null}
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void downloadPng()}
          className="bg-accent rounded-lg px-3 py-2 text-xs font-medium text-white"
        >
          Download PNG
        </button>
        <CopyButton text={asset.image.caption} label="Copy caption" />
        <button type="button" onClick={onDelete} className="text-hot text-xs">
          Delete
        </button>
      </div>
    </article>
  );
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        })
      }
      className="border-border rounded-lg border px-3 py-2 text-xs"
    >
      {done ? 'Copied' : label}
    </button>
  );
}

/**
 * Nostr as a listening source.
 *
 * The only network here with no gatekeeper whatsoever. There is no company to
 * ask for an API key, no tier to pay for, no terms that can be changed to
 * close the door later — a relay is a websocket that accepts a subscription,
 * and anyone may run one. For a product whose whole outreach layer is at the
 * mercy of platform policy, that property is worth something on its own.
 *
 * It is also, honestly, the weakest fit for reaching buyers outside software:
 * the audience is small and heavily crypto-skewed. It is here because it is
 * cheap, because it cannot be taken away, and because unlike Reddit or
 * LinkedIn its direct messages are not somebody else's to forbid.
 *
 * Two protocol details shape this adapter:
 *
 *   - **Search is an extension, not the protocol.** NIP-50 adds a `search`
 *     filter and only some relays implement it. A relay that does not simply
 *     ignores the field and streams recent notes instead, so the terms are
 *     re-checked locally — without that, an unsupporting relay silently turns
 *     a targeted search into a firehose.
 *   - **A subscription does not end.** The relay sends stored events, then
 *     `EOSE` ("end of stored events"), then stays open streaming new ones
 *     forever. Closing on `EOSE` is what makes this a query rather than a
 *     process that never returns.
 */

import {
  excerpt,
  mentionsTerm,
  type FeedPost,
  type FeedSearchInput,
  type FeedSource,
} from './source';

/** Relays that implement NIP-50 search. */
export const DEFAULT_NOSTR_RELAYS = ['wss://relay.nostr.band', 'wss://relay.damus.io'] as const;

/** The subset of the websocket API this adapter uses, so tests can supply one. */
export interface NostrSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'message', handler: (event: { data: unknown }) => void): void;
  addEventListener(type: 'open' | 'error' | 'close', handler: () => void): void;
}

export type NostrSocketFactory = (url: string) => NostrSocket;

export interface NostrSourceOptions {
  readonly relays?: readonly string[];
  readonly timeoutMs?: number;
  readonly socketFactory?: NostrSocketFactory;
}

interface NostrEvent {
  id?: string;
  pubkey?: string;
  created_at?: number;
  kind?: number;
  content?: string;
}

/** Short text notes. Kind 1 is the only one worth listening to here. */
const KIND_TEXT_NOTE = 1;

export class NostrSource implements FeedSource {
  readonly network = 'nostr' as const;
  readonly slug = 'nostr';
  readonly displayName = 'Nostr';

  readonly #relays: readonly string[];
  readonly #timeoutMs: number;
  readonly #socketFactory: NostrSocketFactory;

  constructor(options: NostrSourceOptions = {}) {
    this.#relays = options.relays ?? DEFAULT_NOSTR_RELAYS;
    this.#timeoutMs = options.timeoutMs ?? 8_000;
    this.#socketFactory =
      options.socketFactory ?? ((url) => new WebSocket(url) as unknown as NostrSocket);
  }

  async search(input: FeedSearchInput): Promise<readonly FeedPost[]> {
    const terms = input.terms.filter((t) => t.trim().length > 0);
    if (terms.length === 0) return [];

    const limit = Math.min(input.limit ?? 25, 100);

    // Relays are queried together and failures are ignored individually: they
    // are independent volunteers, and one being down is the normal case rather
    // than an error worth failing a run over.
    const batches = await Promise.all(
      this.#relays.map((relay) =>
        this.#queryRelay(relay, terms, limit, input.since).catch(() => [] as NostrEvent[]),
      ),
    );

    const posts: FeedPost[] = [];
    const seen = new Set<string>();

    for (const events of batches) {
      for (const event of events) {
        const text = event.content?.trim();
        if (!text || !event.id || !event.pubkey) continue;
        // Relays without NIP-50 stream everything; this is what stops that
        // becoming a firehose.
        if (!mentionsTerm(text, terms)) continue;
        if (seen.has(event.id)) continue;
        seen.add(event.id);

        const postedAt = event.created_at
          ? new Date(event.created_at * 1000).toISOString()
          : new Date().toISOString();

        if (input.since && Date.parse(postedAt) < input.since.getTime()) continue;

        posts.push({
          network: 'nostr',
          externalId: event.id,
          authorHandle: event.pubkey,
          authorUrl: `https://njump.me/${event.pubkey}`,
          url: `https://njump.me/${event.id}`,
          text: excerpt(text),
          postedAt,
        });
      }
    }

    return posts;
  }

  #queryRelay(
    url: string,
    terms: readonly string[],
    limit: number,
    since: Date | undefined,
  ): Promise<NostrEvent[]> {
    return new Promise((resolve, reject) => {
      let socket: NostrSocket;
      try {
        socket = this.#socketFactory(url);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      const events: NostrEvent[] = [];
      const subscriptionId = `og-${terms.length}-${limit}`;
      let settled = false;

      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket.close();
        } catch {
          // A relay that already hung up is the outcome we wanted anyway.
        }
        resolve(events);
      };

      // A relay that accepts the connection and then says nothing would
      // otherwise hold the whole listening run open.
      const timer = setTimeout(finish, this.#timeoutMs);

      socket.addEventListener('open', () => {
        socket.send(
          JSON.stringify([
            'REQ',
            subscriptionId,
            {
              kinds: [KIND_TEXT_NOTE],
              search: terms.join(' '),
              limit,
              ...(since ? { since: Math.floor(since.getTime() / 1000) } : {}),
            },
          ]),
        );
      });

      socket.addEventListener('message', (event) => {
        const frame = parseFrame(event.data);
        if (!frame) return;

        if (frame[0] === 'EVENT' && frame[1] === subscriptionId) {
          const payload = frame[2] as NostrEvent | undefined;
          if (payload?.kind === KIND_TEXT_NOTE) events.push(payload);
          return;
        }

        // Stored events are done; anything after this is a live stream we do
        // not want.
        if (frame[0] === 'EOSE' || frame[0] === 'CLOSED') finish();
      });

      socket.addEventListener('error', finish);
      socket.addEventListener('close', finish);
    });
  }
}

function parseFrame(data: unknown): unknown[] | undefined {
  const raw = typeof data === 'string' ? data : undefined;
  if (!raw) return undefined;

  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

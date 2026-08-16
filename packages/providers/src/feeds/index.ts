/**
 * The listening sources.
 *
 * Grouped because they answer one question the rest of the provider layer
 * cannot: *who is talking about this problem right now?* Every other provider
 * starts from a person or a company already known and fills in detail. These
 * start from a sentence and produce the person.
 */

export {
  classifyPost,
  excerpt,
  mentionsTerm,
  FeedRateLimitError,
  type Classification,
  type FeedPost,
  type FeedSearchInput,
  type FeedSource,
} from './source';
export { RedditSource, REDDIT_API, type RedditSourceOptions } from './reddit';
export { RssSource, type RssSourceOptions } from './rss';
export { BlueskyFeedSource, type BlueskyFeedSourceOptions } from './bluesky';
export {
  NostrSource,
  DEFAULT_NOSTR_RELAYS,
  type NostrSocket,
  type NostrSocketFactory,
  type NostrSourceOptions,
} from './nostr';

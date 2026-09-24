/**
 * Reading an account's own audience.
 *
 * One interface, because the watcher has one question — who engaged with this
 * account since I last looked — and the two networks that can answer it do so
 * with completely different machinery. Bluesky's AppView is public and
 * unauthenticated; X's needs the workspace's own OAuth token and a paid plan.
 *
 * The shape that matters here is `AudienceReadResult.unavailable`. A reader
 * that cannot answer says so, with a reason a human can act on ("reconnect X
 * to grant follows.read"), rather than throwing or returning an empty list.
 * Empty and unavailable are different facts: one means nobody engaged, the
 * other means we did not look, and a watcher that confuses them tells a user
 * their audience is dead when their credentials expired.
 */

/** Who did something, as the network describes them. */
export interface AudienceActor {
  readonly handle: string;
  readonly platformUserId?: string | undefined;
  readonly displayName?: string | undefined;
  readonly bio?: string | undefined;
  readonly avatarUrl?: string | undefined;
  readonly profileUrl?: string | undefined;
  readonly followers?: number | undefined;
}

/** One act, against one post (or none, for a follow). */
export interface AudienceEngagement {
  readonly kind: 'follow' | 'like' | 'repost' | 'reply' | 'mention';
  readonly actor: AudienceActor;
  /** Stable id of the post engaged with. Absent for a follow. */
  readonly subjectId?: string | undefined;
  readonly subjectUrl?: string | undefined;
  readonly subjectText?: string | undefined;
  /** When the network says it happened, ISO. Often absent: most APIs do not date a like. */
  readonly at?: string | undefined;
}

export type AudienceReadResult =
  | { readonly ok: true; readonly engagements: readonly AudienceEngagement[] }
  /**
   * `retryable` separates "X is down" from "your plan does not include this".
   * The first is worth another tick; the second needs a human, and retrying it
   * forever is how a watch burns quota producing nothing.
   */
  | { readonly ok: false; readonly reason: string; readonly retryable: boolean };

export interface AudienceReadInput {
  /** Handle or DID of the watched account. */
  readonly account: string;
  /** Which acts to look for; a reader skips the calls it does not need. */
  readonly kinds: readonly AudienceEngagement['kind'][];
  /** How many recent posts to read engagement on. */
  readonly lookbackPosts: number;
  /** Stop after this many engagements, so one viral post cannot fill a queue. */
  readonly limit: number;
}

export interface AudienceReader {
  readonly network: 'bluesky' | 'x';
  read(input: AudienceReadInput): Promise<AudienceReadResult>;
}

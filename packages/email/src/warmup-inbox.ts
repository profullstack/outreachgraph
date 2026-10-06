/**
 * The receiving half of the warm-up network, over IMAP.
 *
 * A warm-up message is found by its `X-OG-Warmup` header in the inbox and in
 * the spam folder. Each one is recorded with where it landed, marked read and
 * moved into its own folder. Moving it out of spam is the "not spam" signal
 * providers learn from; moving it out of the inbox keeps the owner's inbox
 * for real mail.
 */

import { ImapFlow } from 'imapflow';
import type { ImapCredentials } from './imap';

/** Where swept warm-up mail is filed. */
export const WARMUP_FOLDER = 'OutreachGraph Warmup';

export interface SweptWarmup {
  /** The `X-OG-Warmup` token. */
  readonly token: string;
  readonly landed: 'inbox' | 'spam';
  readonly messageId?: string | undefined;
  readonly subject?: string | undefined;
}

/** The seam tests replace. */
export interface WarmupSweeper {
  sweep(since: Date): Promise<SweptWarmup[]>;
}

const SPAM_NAME = /^(spam|junk|junk e-?mail|bulk mail)$/i;

export class ImapWarmupSweeper implements WarmupSweeper {
  readonly #credentials: ImapCredentials;

  constructor(credentials: ImapCredentials) {
    this.#credentials = credentials;
  }

  async sweep(since: Date): Promise<SweptWarmup[]> {
    const client = new ImapFlow({
      host: this.#credentials.host,
      port: this.#credentials.port,
      secure: this.#credentials.secure,
      auth: { user: this.#credentials.username, pass: this.#credentials.password },
      logger: false,
    });

    await client.connect();
    const swept: SweptWarmup[] = [];

    try {
      const folders = await client.list();
      const spam = folders
        .filter((folder) => folder.specialUse === '\\Junk' || SPAM_NAME.test(folder.name))
        .map((folder) => folder.path);
      if (!folders.some((folder) => folder.path === WARMUP_FOLDER)) {
        await client.mailboxCreate(WARMUP_FOLDER).catch(() => undefined);
      }

      const sources: Array<[string, SweptWarmup['landed']]> = [
        ['INBOX', 'inbox'],
        ...spam.map((path): [string, SweptWarmup['landed']] => [path, 'spam']),
      ];

      for (const [path, landed] of sources) {
        const lock = await client.getMailboxLock(path).catch(() => undefined);
        if (!lock) continue;
        try {
          const found = await client.search(
            { header: { 'x-og-warmup': true }, since },
            { uid: true },
          );
          const uids = Array.isArray(found) ? found : [];
          if (uids.length === 0) continue;

          for await (const message of client.fetch(
            uids,
            { envelope: true, headers: ['x-og-warmup'] },
            { uid: true },
          )) {
            const raw = message.headers?.toString() ?? '';
            const token = /x-og-warmup:\s*(\S+)/i.exec(raw)?.[1];
            if (!token) continue;
            swept.push({
              token,
              landed,
              messageId: message.envelope?.messageId,
              subject: message.envelope?.subject,
            });
          }

          await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
          await client.messageMove(uids, WARMUP_FOLDER, { uid: true });
        } finally {
          lock.release();
        }
      }
    } finally {
      await client.logout().catch(() => undefined);
    }

    return swept;
  }
}

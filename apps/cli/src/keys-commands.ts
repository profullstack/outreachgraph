/**
 * `og keys status | unlock [--ttl 8h] | lock`: the workspace key seal.
 *
 * The passphrase is read from OG_KEY_PASSPHRASE or a hidden prompt and never
 * leaves this process: the data key is derived here and only that is sent.
 */

import {
  bytesToBase64,
  isSealRecord,
  parseTtl,
  unlockSeal,
  wipe,
  WrongPassphraseError,
} from '@outreachgraph/secrets/seal';
import type { Command, CommandContext } from './commands';

async function readHidden(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  const stdin = process.stdin;
  return new Promise((resolve) => {
    let buf = '';
    const raw = stdin.isTTY;
    if (raw) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === '\n' || c === '\r' || c === '\u0004') {
          if (raw) stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stderr.write('\n');
          resolve(buf);
          return;
        }
        if (c === '\u0003') process.exit(130);
        buf += c;
      }
    };
    stdin.on('data', onData);
  });
}

async function runKeys({ client, args, flags }: CommandContext): Promise<string> {
  const verb = args[0] ?? 'status';
  if (verb === 'status') {
    const s = (await client.get('/keys')) as {
      state: string;
      expires_at: string | null;
      autopilot_paused: boolean;
    };
    return (
      `${s.state}${s.expires_at ? ` until ${s.expires_at}` : ''}` +
      (s.autopilot_paused ? ' (autopilot paused: unlock to resume)' : '')
    );
  }
  if (verb === 'lock') {
    await client.post('/keys/lock', {});
    return 'locked';
  }
  if (verb === 'unlock') {
    const s = (await client.get('/keys')) as { seal: unknown; workspace_id: string };
    if (!isSealRecord(s.seal)) {
      throw new Error('No workspace key passphrase yet: set one once on the Keys page in the app.');
    }
    const ttl = parseTtl(typeof flags.ttl === 'string' ? flags.ttl : undefined);
    const pass = process.env.OG_KEY_PASSPHRASE ?? (await readHidden('Workspace key passphrase: '));
    let dek: Uint8Array;
    try {
      dek = await unlockSeal(s.seal, pass, s.workspace_id);
    } catch (error) {
      if (error instanceof WrongPassphraseError) throw new Error('wrong passphrase');
      throw error;
    }
    const body = { dek: bytesToBase64(dek), ttl_seconds: ttl };
    wipe(dek);
    const r = (await client.post('/keys/unlock', body)) as { expires_at: string };
    return `unlocked until ${r.expires_at}`;
  }
  throw new Error('og keys status | unlock [--ttl 8h|7d] | lock');
}

export const KEYS_COMMANDS: readonly Command[] = [
  {
    name: 'keys',
    usage: 'og keys status | unlock [--ttl 8h|7d] | lock',
    summary:
      'Workspace key passphrase: autopilot uses your mailboxes and accounts only while unlocked.',
    run: runKeys,
  },
];

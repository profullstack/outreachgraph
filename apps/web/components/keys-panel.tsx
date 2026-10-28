'use client';

// All passphrase work happens here, in the browser (WebCrypto). The API gets
// the seal (ciphertext + salt + public key) at setup and the data key on
// unlock. The passphrase and recovery key never leave this page.
// lib/seal.ts is a byte-for-byte copy of packages/secrets/src/seal.ts (a test
// keeps them identical).

import { useCallback, useEffect, useState } from 'react';
import {
  bytesToBase64,
  createSeal,
  rewrapSeal,
  unlockSeal,
  unlockSealWithRecovery,
  wipe,
  MIN_PASSPHRASE_LENGTH,
  type SealRecord,
} from '../lib/seal';

interface KeysStatus {
  workspace_id: string;
  has_seal: boolean;
  seal: SealRecord | null;
  unlocked: boolean;
  expires_at: string | null;
  state: 'setup_required' | 'locked' | 'unlocked';
  autopilot_paused: boolean;
}

const TTLS: [string, number][] = [
  ['1 hour', 3600],
  ['8 hours', 8 * 3600],
  ['1 day', 86400],
  ['7 days (max)', 7 * 86400],
];

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = (await r.json().catch(() => ({}))) as { error?: { message?: string } } & Record<
    string,
    unknown
  >;
  if (!r.ok) throw new Error(j.error?.message ?? `HTTP ${r.status}`);
  return j;
}

export function KeysPanel() {
  const [status, setStatus] = useState<KeysStatus | null>(null);
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [newPass, setNewPass] = useState('');
  const [recovery, setRecovery] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [ttl, setTtl] = useState(8 * 3600);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [shownRecovery, setShownRecovery] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch('/api/v1/keys', { credentials: 'same-origin', cache: 'no-store' });
    if (r.ok) setStatus((await r.json()) as KeysStatus);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (e) {
      const err = e as Error;
      setMsg(err.name === 'WrongPassphraseError' ? 'Wrong passphrase.' : err.message);
    } finally {
      setBusy(false);
    }
  }

  const setup = () =>
    run(async () => {
      if (!status) return;
      if (pass.length < MIN_PASSPHRASE_LENGTH)
        throw new Error(`Use at least ${MIN_PASSPHRASE_LENGTH} characters.`);
      if (pass !== pass2) throw new Error('The two passphrases differ.');
      setMsg('Deriving your key (a few seconds)...');
      const created = await createSeal(pass, status.workspace_id);
      const dek = bytesToBase64(created.dek);
      wipe(created.dek);
      const res = await post('/api/v1/keys/setup', {
        seal: created.seal,
        dek,
        ttl_seconds: ttl,
        reset: status.has_seal,
      });
      setShownRecovery(created.recoveryKey);
      const migrated = (res.migration as { migrated?: number } | null)?.migrated ?? 0;
      setMsg(`Set up and unlocked. ${migrated} stored credential(s) moved to the workspace key.`);
      setPass('');
      setPass2('');
      setResetting(false);
    });

  const unlock = () =>
    run(async () => {
      if (!status?.seal) return;
      setMsg('Unlocking...');
      const d = useRecovery
        ? await unlockSealWithRecovery(status.seal, recovery, status.workspace_id)
        : await unlockSeal(status.seal, pass, status.workspace_id);
      const dek = bytesToBase64(d);
      wipe(d);
      await post('/api/v1/keys/unlock', { dek, ttl_seconds: ttl });
      setMsg('Unlocked. Autopilot resumes on its next tick.');
      setPass('');
      setRecovery('');
    });

  const lock = () =>
    run(async () => {
      await post('/api/v1/keys/lock', {});
      setMsg('Locked. Autopilot is paused until you unlock.');
    });

  const change = () =>
    run(async () => {
      if (!status?.seal) return;
      if (newPass.length < MIN_PASSPHRASE_LENGTH)
        throw new Error(`Use at least ${MIN_PASSPHRASE_LENGTH} characters.`);
      const d = await unlockSeal(status.seal, pass, status.workspace_id);
      const seal = await rewrapSeal(d, status.seal, newPass, status.workspace_id);
      const dek = bytesToBase64(d);
      wipe(d);
      await post('/api/v1/keys/passphrase', { dek, seal });
      setMsg('Passphrase changed.');
      setPass('');
      setNewPass('');
    });

  if (!status) return <p className="text-ink-muted text-sm">Loading...</p>;

  const input = 'border-border w-full rounded-xl border bg-transparent px-3 py-2 text-sm';
  const button = 'border-border rounded-xl border px-3 py-2 text-sm disabled:opacity-50';
  const ttlPicker = (
    <label className="block text-sm">
      Stay unlocked for{' '}
      <select
        className="border-border ml-2 rounded-lg border bg-transparent px-2 py-1"
        value={ttl}
        onChange={(e) => setTtl(Number(e.target.value))}
      >
        {TTLS.map(([label, s]) => (
          <option key={s} value={s}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="space-y-4">
      <section className="border-border rounded-2xl border p-4 text-sm">
        Status:{' '}
        <strong>
          {status.state === 'setup_required'
            ? 'no passphrase yet'
            : status.state === 'unlocked'
              ? `unlocked until ${new Date(status.expires_at!).toLocaleString()}`
              : 'locked'}
        </strong>
        {status.autopilot_paused && (
          <span className="text-ink-muted"> · autopilot is paused until you unlock</span>
        )}
      </section>

      {shownRecovery && (
        <section className="rounded-2xl border border-amber-500 p-4 text-sm">
          <h2 className="font-semibold">Recovery key (shown once)</h2>
          <p className="mt-1">
            Store it somewhere safe. It is the only way back in if the passphrase is lost.
          </p>
          <code className="mt-2 block font-mono break-all">{shownRecovery}</code>
          <button className={`${button} mt-3`} onClick={() => setShownRecovery(null)}>
            I saved it
          </button>
        </section>
      )}

      {(status.state === 'setup_required' || resetting) && (
        <section className="border-border space-y-3 rounded-2xl border p-4">
          <h2 className="font-semibold">
            {resetting ? 'Start over with a new passphrase' : 'Set a workspace key passphrase'}
          </h2>
          <p className="text-ink-muted text-sm">
            Mailbox passwords and connected-account tokens are sealed under this passphrase;
            OutreachGraph keeps no key that opens them. If you lose both the passphrase and the
            recovery key, they are gone for good and you reconnect your mailboxes and accounts.
          </p>
          <input
            className={input}
            type="password"
            autoComplete="new-password"
            placeholder="Passphrase"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
          />
          <input
            className={input}
            type="password"
            autoComplete="new-password"
            placeholder="Repeat passphrase"
            value={pass2}
            onChange={(e) => setPass2(e.target.value)}
          />
          {ttlPicker}
          <button className={button} disabled={busy} onClick={setup}>
            Set passphrase and unlock
          </button>
        </section>
      )}

      {status.state === 'locked' && !resetting && (
        <section className="border-border space-y-3 rounded-2xl border p-4">
          <h2 className="font-semibold">Unlock</h2>
          {useRecovery ? (
            <input
              className={`${input} font-mono`}
              placeholder="Recovery key"
              value={recovery}
              onChange={(e) => setRecovery(e.target.value)}
            />
          ) : (
            <input
              className={input}
              type="password"
              autoComplete="current-password"
              placeholder="Passphrase"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
            />
          )}
          {ttlPicker}
          <div className="flex gap-2">
            <button className={button} disabled={busy} onClick={unlock}>
              Unlock
            </button>
            <button className={button} onClick={() => setUseRecovery(!useRecovery)}>
              {useRecovery ? 'Use passphrase' : 'Use recovery key'}
            </button>
          </div>
          <button className="text-xs underline" onClick={() => setResetting(true)}>
            Lost both the passphrase and the recovery key?
          </button>
        </section>
      )}

      {status.state === 'unlocked' && (
        <section className="border-border space-y-3 rounded-2xl border p-4">
          <button className={button} disabled={busy} onClick={lock}>
            Lock now
          </button>
          <details>
            <summary className="cursor-pointer text-sm">Change passphrase</summary>
            <div className="mt-3 space-y-2">
              <input
                className={input}
                type="password"
                placeholder="Current passphrase"
                value={pass}
                onChange={(e) => setPass(e.target.value)}
              />
              <input
                className={input}
                type="password"
                autoComplete="new-password"
                placeholder="New passphrase"
                value={newPass}
                onChange={(e) => setNewPass(e.target.value)}
              />
              <button className={button} disabled={busy} onClick={change}>
                Change
              </button>
            </div>
          </details>
        </section>
      )}

      {msg && <p className="text-sm">{msg}</p>}
    </div>
  );
}

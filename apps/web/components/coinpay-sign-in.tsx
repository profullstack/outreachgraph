'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Sign in with CoinPay. The API runs the OAuth flow (PKCE, state, nonce, the
 * id_token checked, the account bound to the CoinPay `sub`); these are plain
 * links to its start route.
 */

/** The primary button on the sign-in page, above the email form. */
export function CoinpaySignInButton({ next, mode }: { next: string; mode: 'login' | 'register' }) {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    fetch('/api/v1/coinpay/oauth/enabled', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { enabled?: boolean } | null) => setEnabled(Boolean(body?.enabled)))
      .catch(() => setEnabled(false));
  }, []);
  if (!enabled) return null;
  return (
    <div className="flex flex-col gap-3">
      <a
        href={`/api/v1/coinpay/oauth/start?next=${encodeURIComponent(next)}`}
        className="bg-accent rounded-xl px-4 py-3 text-center text-sm font-medium text-white"
      >
        {mode === 'register' ? 'Sign up with CoinPay' : 'Sign in with CoinPay'}
      </a>
      <p className="text-ink-muted text-center text-xs">or with your email and password</p>
    </div>
  );
}

interface CoinpayStatus {
  enabled: boolean;
  linked: boolean;
  canDisconnect: boolean;
}

const RESULT: Record<string, { text: string; ok: boolean }> = {
  linked: { text: 'CoinPay connected.', ok: true },
  taken: {
    text: 'That CoinPay account is already linked to another OutreachGraph account.',
    ok: false,
  },
  already_linked: {
    text: 'This account already has a different CoinPay account connected.',
    ok: false,
  },
};

/** Connect / Disconnect on the Settings page. */
export function CoinpayConnect() {
  const [status, setStatus] = useState<CoinpayStatus | null>(null);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/v1/me/coinpay', {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      setStatus(response.ok ? ((await response.json()) as CoinpayStatus) : null);
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void load();
    const result = new URLSearchParams(window.location.search).get('coinpay');
    if (result && RESULT[result]) setMessage(RESULT[result]);
  }, [load]);

  if (!status?.enabled) return null;

  async function disconnect() {
    setBusy(true);
    try {
      const response = await fetch('/api/v1/me/coinpay', {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? 'Could not disconnect CoinPay.');
      setMessage({ text: 'CoinPay disconnected.', ok: true });
      await load();
    } catch (error) {
      setMessage({ text: (error as Error).message, ok: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-border bg-surface-raised flex flex-col gap-2 rounded-2xl border p-4">
      <span className="text-sm font-semibold">Sign in with CoinPay</span>
      {status.linked ? (
        status.canDisconnect ? (
          <button
            type="button"
            onClick={disconnect}
            disabled={busy}
            className="text-ink-muted self-start text-sm underline"
          >
            Connected. Disconnect CoinPay
          </button>
        ) : (
          <span className="text-ink-muted text-xs">
            Connected. CoinPay is this account&apos;s only sign-in, so it stays connected.
          </span>
        )
      ) : (
        <a
          href="/api/v1/coinpay/oauth/start?mode=connect"
          className="text-accent self-start text-sm font-medium"
        >
          Connect CoinPay ›
        </a>
      )}
      {message ? (
        <p
          role={message.ok ? 'status' : 'alert'}
          className={message.ok ? 'text-ink-muted text-xs' : 'text-hot text-xs'}
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}

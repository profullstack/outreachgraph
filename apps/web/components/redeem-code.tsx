'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

/**
 * "Have a code?": redeems a credit code into this organization's prospect
 * credits, the same balance credit packs fill.
 */
export function RedeemCode() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | undefined>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(undefined);
    try {
      const response = await fetch('/api/v1/credits/redeem', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ code }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        prospects?: number;
        error?: { message?: string };
      };
      if (!response.ok) {
        setMessage({ ok: false, text: body.error?.message ?? 'That code did not work.' });
        return;
      }
      setMessage({
        ok: true,
        text: `Added ${(body.prospects ?? 0).toLocaleString()} prospect credits.`,
      });
      setCode('');
      router.refresh();
    } catch {
      setMessage({ ok: false, text: 'Could not reach the API.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="border-border bg-surface-raised mt-4 rounded-2xl border p-4">
      <h2 className="font-medium">Have a code?</h2>
      <p className="text-ink-muted mt-1 text-sm">
        A credit code adds prospect credits to this organization. Each code works once per person.
      </p>
      <form onSubmit={submit} className="mt-3 flex flex-col gap-2 sm:flex-row">
        <label className="sr-only" htmlFor="credit-code">
          Credit code
        </label>
        <input
          id="credit-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="OG-XXXX-XXXX-XXXX-XXXX"
          autoComplete="off"
          spellCheck={false}
          maxLength={48}
          required
          className="border-border bg-surface min-w-0 flex-1 rounded-xl border px-3 py-2 font-mono text-sm uppercase"
        />
        <button
          type="submit"
          disabled={busy || !code.trim()}
          className="bg-accent rounded-xl px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {busy ? 'Redeeming…' : 'Redeem'}
        </button>
      </form>
      {message ? (
        <p role="status" className={`mt-2 text-sm ${message.ok ? '' : 'text-hot'}`}>
          {message.text}
        </p>
      ) : null}
      <p className="text-ink-muted mt-3 text-xs">
        Know someone who should be here?{' '}
        <Link href="/invites" className="underline">
          Send one of your invites
        </Link>
        .
      </p>
    </section>
  );
}

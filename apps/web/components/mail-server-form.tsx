'use client';

import { useState, type FormEvent } from 'react';
import type { EmailAccountView, EmailTestResult } from '../lib/api';

/**
 * Connecting your own mail server.
 *
 * The screen is built around one idea: saving is not connecting. A saved
 * configuration is inert until a test has actually opened a socket,
 * authenticated, and delivered a message — so the primary button after saving
 * is "Send a test", and the badge stays amber until that succeeds. Outreach
 * genuinely will not send through an unverified account, and the interface
 * would be lying if it looked finished before then.
 *
 * The password field is write-only. It is never sent back from the API, so it
 * renders empty with a note that blank means unchanged; the alternative is
 * either a fake bullet string that people try to edit, or making someone retype
 * a password to correct a port number.
 */
export function MailServerForm({
  initial,
  testTo,
}: {
  initial: EmailAccountView;
  testTo: string | null;
}) {
  const [account, setAccount] = useState(initial);
  const [host, setHost] = useState(initial.host ?? '');
  const [port, setPort] = useState(initial.port ?? 587);
  const [secure, setSecure] = useState(initial.secure ?? false);
  const [username, setUsername] = useState(initial.username ?? '');
  const [password, setPassword] = useState('');
  const [fromEmail, setFromEmail] = useState(initial.fromEmail ?? '');
  const [fromName, setFromName] = useState(initial.fromName ?? '');
  const [replyTo, setReplyTo] = useState(initial.replyTo ?? '');
  const [allowInvalidCertificate, setAllowInvalidCertificate] = useState(
    initial.allowInvalidCertificate ?? false,
  );
  const [allowInsecureAuth, setAllowInsecureAuth] = useState(initial.allowInsecureAuth ?? false);
  const [to, setTo] = useState(testTo ?? '');

  const [busy, setBusy] = useState<'save' | 'test' | 'remove' | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [result, setResult] = useState<EmailTestResult | undefined>();
  const [saved, setSaved] = useState(false);

  const dirty = () => {
    setSaved(false);
    setResult(undefined);
  };

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy('save');
    setError(undefined);
    setResult(undefined);

    try {
      const response = await fetch('/api/v1/settings/email', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          host,
          port,
          secure,
          username,
          password,
          fromEmail,
          fromName,
          replyTo,
          allowInvalidCertificate,
          allowInsecureAuth,
        }),
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(payload?.error?.message ?? `that failed (${response.status})`);
        return;
      }

      setAccount(payload.account);
      // Cleared so a saved password is never held in the page longer than the
      // request that carried it.
      setPassword('');
      setSaved(true);
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(undefined);
    }
  }

  async function test() {
    setBusy('test');
    setError(undefined);
    setResult(undefined);

    try {
      const response = await fetch('/api/v1/settings/email/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ to }),
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(payload?.error?.message ?? `that failed (${response.status})`);
        return;
      }

      setResult(payload);
      if (payload.account) setAccount(payload.account);
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(undefined);
    }
  }

  async function remove() {
    setBusy('remove');
    setError(undefined);

    try {
      await fetch('/api/v1/settings/email', { method: 'DELETE', credentials: 'same-origin' });
      setAccount({ configured: false, canStore: account.canStore });
      setHost('');
      setUsername('');
      setPassword('');
      setResult(undefined);
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(undefined);
    }
  }

  const verified = account.status === 'verified';

  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      <section className="border-border bg-surface-raised rounded-2xl border p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Your mail server</h2>
            <p className="text-ink-muted mt-1 text-[13px] leading-relaxed">
              Outreach goes out from your domain, with replies straight to you. Until this is
              verified, nothing is sent through it.
            </p>
          </div>
          <StatusBadge account={account} />
        </div>

        {!account.canStore ? (
          <p role="alert" className="text-hot mt-3 text-sm">
            This deployment cannot store credentials securely yet — set CREDENTIAL_KEY on the
            service first.
          </p>
        ) : null}

        <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_7rem]">
          <div>
            <label htmlFor="host" className="text-ink-muted block text-xs">
              Server
            </label>
            <input
              id="host"
              value={host}
              onChange={(e) => {
                setHost(e.target.value);
                dirty();
              }}
              placeholder="smtp.example.com"
              autoComplete="off"
              className="border-border bg-surface mt-1 w-full rounded-xl border px-3 py-2.5"
            />
          </div>

          <div>
            <label htmlFor="port" className="text-ink-muted block text-xs">
              Port
            </label>
            <input
              id="port"
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(e) => {
                const next = Number(e.target.value);
                setPort(next);
                // 465 is implicit TLS and 587 is STARTTLS. Getting this pair
                // wrong is the single most common SMTP misconfiguration, and
                // the port is the better signal of intent, so it drives the
                // switch rather than the other way round.
                if (next === 465) setSecure(true);
                if (next === 587 || next === 25) setSecure(false);
                dirty();
              }}
              className="border-border bg-surface mt-1 w-full rounded-xl border px-3 py-2.5 tabular-nums"
            />
          </div>
        </div>

        <label className="mt-3 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={secure}
            onChange={(e) => {
              setSecure(e.target.checked);
              dirty();
            }}
            className="mt-0.5"
          />
          <span>
            <span className="font-medium">Connect over TLS immediately</span>
            <span className="text-ink-muted block text-[13px] leading-relaxed">
              On for port 465. Off for 587, which starts in the clear and upgrades before the
              password is sent.
            </span>
          </span>
        </label>

        {/*
          Behind a disclosure, because almost nobody needs them and anyone who
          does knows the words. Both weaken a real protection, so each says
          plainly what it gives up rather than being labelled "advanced".
        */}
        <details className="mt-3">
          <summary className="text-ink-muted cursor-pointer text-xs">
            My server has a private certificate, or no TLS at all
          </summary>

          <label className="mt-2 flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={allowInvalidCertificate}
              onChange={(e) => {
                setAllowInvalidCertificate(e.target.checked);
                dirty();
              }}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium">Accept a certificate we cannot verify</span>
              <span className="text-ink-muted block text-[13px] leading-relaxed">
                For a server using its own certificate authority. The connection stays encrypted,
                but we can no longer prove who is on the other end.
              </span>
            </span>
          </label>

          <label className="mt-3 flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={allowInsecureAuth}
              onChange={(e) => {
                setAllowInsecureAuth(e.target.checked);
                dirty();
              }}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium">Send the password without encryption</span>
              <span className="text-ink-muted block text-[13px] leading-relaxed">
                Only for a relay on the same machine. Over a network, anyone in the path can read
                the password.
              </span>
            </span>
          </label>
        </details>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="username" className="text-ink-muted block text-xs">
              Username
            </label>
            <input
              id="username"
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                dirty();
              }}
              autoComplete="off"
              className="border-border bg-surface mt-1 w-full rounded-xl border px-3 py-2.5"
            />
          </div>

          <div>
            <label htmlFor="password" className="text-ink-muted block text-xs">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                dirty();
              }}
              autoComplete="new-password"
              placeholder={account.hasPassword ? 'leave blank to keep the stored one' : ''}
              className="border-border bg-surface mt-1 w-full rounded-xl border px-3 py-2.5"
            />
          </div>
        </div>
      </section>

      <section className="border-border bg-surface-raised rounded-2xl border p-4">
        <h2 className="text-sm font-semibold">How your messages appear</h2>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="fromEmail" className="text-ink-muted block text-xs">
              From address
            </label>
            <input
              id="fromEmail"
              type="email"
              value={fromEmail}
              onChange={(e) => {
                setFromEmail(e.target.value);
                dirty();
              }}
              placeholder="you@yourcompany.com"
              className="border-border bg-surface mt-1 w-full rounded-xl border px-3 py-2.5"
            />
          </div>

          <div>
            <label htmlFor="fromName" className="text-ink-muted block text-xs">
              From name
            </label>
            <input
              id="fromName"
              value={fromName}
              onChange={(e) => {
                setFromName(e.target.value);
                dirty();
              }}
              placeholder="Your name"
              className="border-border bg-surface mt-1 w-full rounded-xl border px-3 py-2.5"
            />
          </div>
        </div>

        <label htmlFor="replyTo" className="text-ink-muted mt-4 block text-xs">
          Replies go to
        </label>
        <input
          id="replyTo"
          type="email"
          value={replyTo}
          onChange={(e) => {
            setReplyTo(e.target.value);
            dirty();
          }}
          placeholder={fromEmail || 'the from address'}
          className="border-border bg-surface mt-1 w-full rounded-xl border px-3 py-2.5"
        />
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={busy !== undefined || !account.canStore}
          className="bg-accent rounded-xl px-5 py-3 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>

        {account.configured ? (
          <button
            type="button"
            onClick={test}
            disabled={busy !== undefined}
            className="border-border rounded-xl border px-5 py-3 text-sm font-medium disabled:opacity-40"
          >
            {busy === 'test' ? 'Testing…' : 'Send a test'}
          </button>
        ) : null}

        {account.configured ? (
          <button
            type="button"
            onClick={remove}
            disabled={busy !== undefined}
            className="text-ink-muted px-2 py-3 text-sm underline disabled:opacity-40"
          >
            Disconnect
          </button>
        ) : null}

        {saved ? (
          <span className="text-ink-muted text-sm">Saved. Send a test to start using it.</span>
        ) : null}
      </div>

      {account.configured ? (
        <div>
          <label htmlFor="testTo" className="text-ink-muted block text-xs">
            Send the test to
          </label>
          <input
            id="testTo"
            type="email"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="border-border bg-surface mt-1 w-full max-w-sm rounded-xl border px-3 py-2.5"
          />
        </div>
      ) : null}

      {result ? (
        <p
          role="status"
          className={`rounded-2xl border p-4 text-sm ${
            result.ok ? 'border-border' : 'border-hot text-hot'
          }`}
        >
          {result.ok ? (
            <>
              <span className="font-medium">It works.</span> A test message is on its way to{' '}
              {result.sentTo}
              {result.encrypted === false ? ' over an unencrypted connection' : ''}.{' '}
              {result.greeting ? (
                <span className="text-ink-muted block text-xs">Server said: {result.greeting}</span>
              ) : null}
            </>
          ) : (
            (result.error ?? 'the test failed')
          )}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-hot text-sm">
          {error}
        </p>
      ) : null}

      {account.status === 'failed' && account.lastError && !result ? (
        <p className="text-ink-muted text-sm">Last test failed: {account.lastError}</p>
      ) : null}

      {verified ? null : account.configured ? (
        <p className="text-ink-muted text-sm">
          Outreach will keep going out from our domain until this test passes.
        </p>
      ) : null}
    </form>
  );
}

function StatusBadge({ account }: { account: EmailAccountView }) {
  if (!account.configured) {
    return (
      <span className="border-border text-ink-muted shrink-0 rounded-full border px-3 py-1 text-xs">
        Not connected
      </span>
    );
  }

  if (account.status === 'verified') {
    return (
      <span className="border-accent text-accent shrink-0 rounded-full border px-3 py-1 text-xs font-medium">
        Verified
      </span>
    );
  }

  if (account.status === 'failed') {
    return (
      <span className="border-hot text-hot shrink-0 rounded-full border px-3 py-1 text-xs font-medium">
        Test failed
      </span>
    );
  }

  return (
    <span className="border-border shrink-0 rounded-full border px-3 py-1 text-xs">Not tested</span>
  );
}

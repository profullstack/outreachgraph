'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { WebhooksView } from '../lib/api';

/**
 * Where the workspace's events go: Slack, Zapier, Make, n8n, or a server of
 * the customer's own.
 *
 * Built like the API keys form, for the same reason: the signing secret is
 * shown once, here, the moment the endpoint is created, and never again. The
 * list shows only a hint of each URL because the URL itself is frequently a
 * credential — anyone holding a Slack hook can post into that channel.
 *
 * "Send test" queues a ping through the same worker path real events take, so
 * the last-delivery line under an endpoint is the honest answer to "does it
 * work", a few seconds later.
 */
export function WebhooksForm({ initial }: { initial: WebhooksView }) {
  const router = useRouter();
  const [url, setUrl] = useState('');
  const [kind, setKind] = useState<'generic' | 'slack'>('generic');
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [fresh, setFresh] = useState<{ urlHint: string; secret: string } | undefined>();

  function toggle(event: string): void {
    setSelected((current) =>
      current.includes(event) ? current.filter((e) => e !== event) : [...current, event],
    );
  }

  async function add(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy('add');
    setError(undefined);
    setNotice(undefined);

    try {
      const response = await fetch('/api/v1/webhooks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ url, kind, events: selected }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        endpoint?: { urlHint: string };
        secret?: string;
        error?: { message?: string };
      };

      if (!response.ok || !payload.endpoint || !payload.secret) {
        setError(payload.error?.message ?? `that failed (${response.status})`);
        return;
      }

      setFresh({ urlHint: payload.endpoint.urlHint, secret: payload.secret });
      setUrl('');
      setSelected([]);
      router.refresh();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(undefined);
    }
  }

  async function test(id: string): Promise<void> {
    setBusy(id);
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await fetch(`/api/v1/webhooks/${id}/test`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        setError(`could not queue a test (${response.status})`);
        return;
      }
      setNotice('Test queued. It goes out within a minute; refresh to see how it landed.');
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(undefined);
    }
  }

  async function remove(id: string, label: string): Promise<void> {
    if (!confirm(`Remove ${label}? It stops receiving events now.`)) return;
    setBusy(id);
    setError(undefined);
    try {
      const response = await fetch(`/api/v1/webhooks/${id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        setError(`could not remove (${response.status})`);
        return;
      }
      router.refresh();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <section className="border-border rounded-2xl border p-4">
      <h2 className="text-base font-semibold">Webhooks</h2>
      <p className="text-ink-muted mt-1 text-sm">
        Send replies, clicks, approvals and sends to Slack, or to Zapier, Make, n8n or your own
        server as signed JSON. Verify <code>X-OutreachGraph-Signature</code> (<code>t=…,v1=…</code>)
        as HMAC-SHA256 of <code>t.body</code> with the secret.
      </p>

      {!initial.canCreate ? (
        <p className="text-ink-muted border-border mt-3 rounded-xl border border-dashed p-3 text-xs">
          This deployment has no encryption key set, so a webhook cannot be stored safely.
        </p>
      ) : null}

      {fresh ? (
        <div className="border-accent mt-3 rounded-xl border p-3 text-sm">
          <p className="font-medium">
            {fresh.urlHint} is ready. Copy the signing secret now; it is not shown again.
          </p>
          <code className="mt-2 block break-all rounded-lg bg-black/5 p-2 text-xs">
            {fresh.secret}
          </code>
        </div>
      ) : null}

      <ul className="mt-3 flex flex-col gap-2">
        {initial.endpoints.length === 0 ? (
          <li className="border-border text-ink-muted rounded-xl border border-dashed p-3 text-xs">
            No webhooks yet.
          </li>
        ) : null}
        {initial.endpoints.map((endpoint) => (
          <li
            key={endpoint.id}
            className="border-border flex items-center justify-between gap-3 rounded-xl border p-3 text-sm"
          >
            <div className="min-w-0">
              <p className="truncate font-medium">
                {endpoint.kind === 'slack' ? 'Slack · ' : ''}
                {endpoint.urlHint}
                {endpoint.active ? '' : ' (disabled)'}
              </p>
              <p className="text-ink-muted text-xs">
                {endpoint.events.length === 0 ? 'All events' : endpoint.events.join(', ')}
                {endpoint.lastDelivery
                  ? ` · last ${endpoint.lastDelivery.status}` +
                    (endpoint.lastDelivery.statusCode
                      ? ` (${endpoint.lastDelivery.statusCode})`
                      : '') +
                    ` ${new Date(endpoint.lastDelivery.at).toLocaleString()}`
                  : ' · nothing sent yet'}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                disabled={busy === endpoint.id}
                onClick={() => test(endpoint.id)}
                className="border-border rounded-xl border px-3 py-2 text-xs disabled:opacity-40"
              >
                Send test
              </button>
              <button
                type="button"
                disabled={busy === endpoint.id}
                onClick={() => remove(endpoint.id, endpoint.urlHint)}
                className="border-border rounded-xl border px-3 py-2 text-xs disabled:opacity-40"
              >
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>

      <form onSubmit={add} className="mt-3 flex flex-col gap-2">
        <div className="flex items-end gap-2">
          <label className="flex-1 text-sm">
            <span className="text-ink-muted text-xs">Endpoint URL (https)</span>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={
                kind === 'slack'
                  ? 'https://hooks.slack.com/services/…'
                  : 'https://hooks.zapier.com/hooks/catch/…'
              }
              required
              type="url"
              className="border-border mt-1 w-full rounded-xl border p-2 text-sm"
            />
          </label>
          <label className="text-sm">
            <span className="text-ink-muted text-xs">Format</span>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value === 'slack' ? 'slack' : 'generic')}
              className="border-border mt-1 block rounded-xl border p-2 text-sm"
            >
              <option value="generic">Signed JSON</option>
              <option value="slack">Slack message</option>
            </select>
          </label>
        </div>

        <fieldset className="flex flex-wrap gap-x-3 gap-y-1">
          <legend className="text-ink-muted mb-1 text-xs">Events (none ticked means all)</legend>
          {initial.events.map((event) => (
            <label key={event} className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={selected.includes(event)}
                onChange={() => toggle(event)}
              />
              <code>{event}</code>
            </label>
          ))}
        </fieldset>

        <div>
          <button
            type="submit"
            disabled={busy === 'add' || !url.trim() || !initial.canCreate}
            className="bg-accent rounded-xl px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {busy === 'add' ? 'Adding…' : 'Add webhook'}
          </button>
        </div>
      </form>

      {notice ? <p className="mt-2 text-sm text-emerald-600">{notice}</p> : null}
      {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
    </section>
  );
}

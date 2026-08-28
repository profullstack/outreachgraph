'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { ProductSummaryView } from '../lib/types';

/**
 * The one box.
 *
 * This replaces two separate intakes that both asked the wrong question: a
 * GitHub username, which is not how anyone describes a sales target, and a
 * list of URLs, which assumes you already know every company you want to
 * reach. Either a website or a description of a market works here, and the
 * server decides which it got — the user should not have to pick a mode
 * before they have said what they want.
 *
 * Autopilot is a checkbox rather than a separate flow, and it is on by
 * default, because a product that promises to run unattended and then makes
 * unattended the advanced option is not really offering it.
 *
 * **Which product this run sells** is the second question, and it only exists
 * once there is a second answer. A workspace selling one thing never sees the
 * control; a workspace selling two had no way to say, and every campaign was
 * silently ground in the older offering — the run found the right companies
 * and pitched them the wrong product.
 */
export function CampaignIntake({ products = [] }: { products?: ProductSummaryView[] }) {
  const router = useRouter();
  const [input, setInput] = useState('');
  const [autopilot, setAutopilot] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();

  // Only products someone actually described. The placeholder a first campaign
  // bootstraps is not a choice, and offering it as one asks the user to pick
  // between "Unconfigured offering" and nothing.
  const sellable = products.filter((product) => product.configured);
  const [offeringId, setOfferingId] = useState(sellable[0]?.offeringId ?? '');

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!input.trim()) return;

    setBusy(true);
    setError(undefined);
    setNote(undefined);

    try {
      const response = await fetch('/api/v1/campaigns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ input, autopilot, ...(offeringId ? { offeringId } : {}) }),
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(payload?.error?.message ?? `that failed (${response.status})`);
        return;
      }

      // The two paths deserve different words. A URL is already being fetched;
      // a keyword has to be turned into companies first, and saying "queued"
      // for both makes the slower one look stuck.
      setNote(
        payload.kind === 'url'
          ? `Reading ${payload.seed} now. Anyone worth contacting there will appear in your funnel.`
          : `Working out who matches “${payload.seed}”. Companies start appearing within a minute or two.`,
      );

      if (payload.needsProfile) {
        setNote(
          (current) =>
            `${current ?? ''} You have not said what you sell yet, so the first drafts will be generic — fix that in Setup.`,
        );
      }

      setInput('');
      router.refresh();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="border-border bg-surface-raised rounded-2xl border p-4">
      <label htmlFor="intake" className="text-sm font-medium">
        Who do you want to reach?
      </label>
      <p className="text-ink-muted mt-1 text-xs">
        A company website — <code>acme.com</code> — or a description of a market, like “dental
        practices in Austin”. Either one starts a campaign.
      </p>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input
          id="intake"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="acme.com — or independent bike shops in Portland"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="border-border bg-surface min-w-0 flex-1 rounded-xl border px-3 py-3"
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="bg-accent shrink-0 rounded-xl px-4 py-3 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? 'Starting…' : 'Start'}
        </button>
      </div>

      {sellable.length > 1 ? (
        <div className="mt-3">
          <label htmlFor="intake-product" className="text-sm font-medium">
            Which product are you selling them?
          </label>
          <p className="text-ink-muted mt-1 text-xs">
            Every draft in this campaign is grounded in what this product claims, and written in its
            voice.
          </p>
          <select
            id="intake-product"
            value={offeringId}
            onChange={(e) => setOfferingId(e.target.value)}
            className="border-border bg-surface mt-2 w-full rounded-xl border px-3 py-3 text-sm"
          >
            {sellable.map((product) => (
              <option key={product.offeringId} value={product.offeringId}>
                {product.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <label className="mt-3 flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={autopilot}
          onChange={(e) => setAutopilot(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          <span className="font-medium">Run it on autopilot</span>
          <span className="text-ink-muted block text-[13px] leading-relaxed">
            Find people, write to them and keep going without asking. Replies come straight to your
            inbox — that is the only part you handle. Leave this off to approve each message
            yourself.
          </span>
        </span>
      </label>

      {busy ? <p className="text-ink-muted mt-2 text-xs">Setting up the campaign…</p> : null}

      {note ? <p className="text-ink-muted mt-3 text-sm">{note}</p> : null}

      {error ? (
        <p role="alert" className="text-hot mt-3 text-sm">
          {error}
        </p>
      ) : null}
    </form>
  );
}

'use client';

import { useState } from 'react';
import type { BillingView, CreditPackView } from '../lib/api';

/**
 * Buying prospect credits.
 *
 * The checkout itself is CoinPayPortal's hosted page, so this component's only
 * real job is to be honest before sending someone there: what a pack costs,
 * what it buys, and that the price is quoted in dollars. The coin (or PayPal)
 * is chosen on CoinPay's hosted checkout page, not here.
 *
 * There is no "confirming payment" spinner here on purpose. A chain payment
 * settles when it settles, and a page that pretends to wait for it either lies
 * for thirty seconds or strands somebody who closed the tab. The purchase
 * appears in the list below as `pending` and becomes `confirmed` when the
 * webhook lands, which is the truth and is also resumable.
 */

export function CreditPacks({ initial }: { initial: BillingView }) {
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const monthlyLeft = Math.max(
    0,
    initial.plan.prospectsPerMonth - initial.usage.prospectsContacted,
  );

  async function buy(pack: CreditPackView): Promise<void> {
    setBusy(pack.id);
    setError(undefined);

    try {
      const response = await fetch('/api/v1/billing/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ packId: pack.id }),
      });

      const body = (await response.json()) as {
        paymentUrl?: string;
        error?: { message?: string };
      };

      if (!response.ok || !body.paymentUrl) {
        setError(body.error?.message ?? 'Could not start the checkout.');
        setBusy(undefined);
        return;
      }

      // Leaves the app for CoinPayPortal's hosted page. Not a new tab: a
      // payment page opened in the background is one people lose.
      window.location.href = body.paymentUrl;
    } catch {
      setError('Could not reach the API.');
      setBusy(undefined);
    }
  }

  return (
    <section className="border-border bg-surface-raised rounded-2xl border p-4">
      <h2 className="font-medium">Prospect credits</h2>
      <p className="text-ink-muted mt-1 text-sm">
        Credits cover prospects beyond your monthly allowance. They never expire and are used only
        once the plan&rsquo;s {initial.plan.prospectsPerMonth.toLocaleString()} are gone.
      </p>

      <dl className="mt-4 grid grid-cols-3 gap-3 text-sm">
        <div>
          <dt className="text-ink-muted text-xs">Plan</dt>
          <dd className="font-medium">{initial.plan.name}</dd>
        </div>
        <div>
          <dt className="text-ink-muted text-xs">Left this month</dt>
          <dd className="font-medium">{monthlyLeft.toLocaleString()}</dd>
        </div>
        <div>
          <dt className="text-ink-muted text-xs">Credits</dt>
          <dd className="font-medium">{initial.credits.remaining.toLocaleString()}</dd>
        </div>
      </dl>

      {initial.onCredits ? (
        <p className="border-border mt-3 rounded-xl border border-dashed p-3 text-xs">
          This month&rsquo;s allowance is spent. Outreach is running on credits.
        </p>
      ) : null}

      {initial.exhausted ? (
        <p className="border-border mt-3 rounded-xl border border-dashed p-3 text-xs">
          Outreach is paused: the monthly allowance and any credits are both gone.
        </p>
      ) : null}

      {!initial.canPurchase ? (
        <p className="text-ink-muted mt-4 text-sm">
          This deployment has no payment credentials configured, so credits are not for sale here.
        </p>
      ) : (
        <>
          <p className="text-ink-muted mt-4 text-xs">
            Prices are in US dollars. Pay with any major coin or PayPal on the CoinPay checkout
            page.
          </p>

          <ul className="mt-4 flex flex-col gap-2">
            {initial.packs.map((pack) => (
              <li
                key={pack.id}
                className="border-border flex items-center justify-between rounded-xl border p-3"
              >
                <div>
                  <div className="text-sm font-medium">{pack.name}</div>
                  <div className="text-ink-muted text-xs">
                    ${pack.priceUsd} · ${(pack.priceUsd / pack.credits).toFixed(3)} a prospect
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void buy(pack)}
                  disabled={busy !== undefined}
                  className="border-border rounded-xl border px-3 py-2 text-sm font-medium disabled:opacity-50"
                >
                  {busy === pack.id ? 'Opening…' : `Buy $${pack.priceUsd}`}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}

      {initial.purchases.length > 0 ? (
        <div className="mt-6">
          <h3 className="text-ink-muted text-xs">Recent purchases</h3>
          <ul className="divide-border mt-1 divide-y text-sm">
            {initial.purchases.map((purchase) => (
              <li key={purchase.id} className="flex items-center justify-between py-2">
                <span>
                  {purchase.credits.toLocaleString()} credits
                  <span className="text-ink-muted"> · ${purchase.amount_usd}</span>
                </span>
                <span className="text-ink-muted text-xs">
                  {purchase.status}
                  {/* A pending payment keeps its link, so closing the tab
                      mid-checkout is recoverable rather than a lost payment. */}
                  {purchase.status === 'pending' && purchase.payment_url ? (
                    <>
                      {' · '}
                      <a href={purchase.payment_url} className="underline">
                        finish
                      </a>
                    </>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

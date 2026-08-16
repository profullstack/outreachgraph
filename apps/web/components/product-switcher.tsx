'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ProductSummaryView } from '../lib/types';

/**
 * Which product this setup page is describing.
 *
 * A workspace sells more than one thing, and until now setup could only ever
 * see the first: describing a second overwrote the first, and the single
 * campaign was repointed at the new offering, so the original product silently
 * stopped being sold. This is the control that makes the others reachable.
 *
 * Rendered as links rather than as a `<select>` on purpose — each product is a
 * URL (`/setup?product=<id>`), which means the browser's back button works,
 * the page can be reloaded, and a half-finished edit to one product is not
 * carried over into another by a client-side state swap.
 */
export function ProductSwitcher({
  products,
  activeOfferingId,
  adding,
}: {
  products: ProductSummaryView[];
  activeOfferingId?: string;
  adding: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  // A workspace with nothing configured has no choice to make, and a row of
  // one placeholder pill is noise on the page someone is using to fix that.
  const configured = products.filter((p) => p.configured);
  if (configured.length === 0 && !adding) return null;

  async function archive(product: ProductSummaryView): Promise<void> {
    if (
      !confirm(
        `Stop selling ${product.name}? Its campaign is archived — everything already sent is kept.`,
      )
    ) {
      return;
    }

    setBusy(product.offeringId);
    setError(undefined);

    try {
      const response = await fetch(`/api/v1/products/${product.offeringId}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });

      if (!response.ok) {
        setError(`could not archive that (${response.status})`);
        return;
      }

      router.push('/setup');
      router.refresh();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(undefined);
    }
  }

  const active = configured.find((p) => p.offeringId === activeOfferingId);

  return (
    <section className="mb-4">
      <h2 className="text-ink-muted mb-2 text-[11px] font-semibold tracking-wide uppercase">
        Products
      </h2>

      <div className="flex flex-wrap gap-2">
        {configured.map((product) => {
          const current = !adding && product.offeringId === activeOfferingId;

          return (
            <Link
              key={product.offeringId}
              href={`/setup?product=${encodeURIComponent(product.offeringId)}`}
              aria-current={current ? 'page' : undefined}
              className={
                current
                  ? 'bg-accent rounded-xl px-3 py-2 text-sm font-medium text-white'
                  : 'border-border bg-surface-raised rounded-xl border px-3 py-2 text-sm'
              }
            >
              {product.name}
              {product.campaignStatus === 'archived' ? (
                <span className="ml-2 text-xs opacity-70">archived</span>
              ) : null}
            </Link>
          );
        })}

        <Link
          href="/setup?product=new"
          aria-current={adding ? 'page' : undefined}
          className={
            adding
              ? 'bg-accent rounded-xl px-3 py-2 text-sm font-medium text-white'
              : 'border-border rounded-xl border border-dashed px-3 py-2 text-sm'
          }
        >
          + Add a product
        </Link>
      </div>

      {active && active.campaignStatus !== 'archived' ? (
        <button
          type="button"
          onClick={() => void archive(active)}
          disabled={busy === active.offeringId}
          className="text-ink-muted mt-2 text-xs underline disabled:opacity-40"
        >
          {busy === active.offeringId ? 'Archiving…' : `Stop selling ${active.name}`}
        </button>
      ) : null}

      {error ? (
        <p role="alert" className="text-hot mt-2 text-sm">
          {error}
        </p>
      ) : null}
    </section>
  );
}

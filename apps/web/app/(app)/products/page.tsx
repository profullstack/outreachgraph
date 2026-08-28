import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PageGuide } from '../../../components/page-guide';
import { ApiUnavailableError, NotAuthenticatedError, fetchProducts } from '../../../lib/api';
import type { ProductSummaryView } from '../../../lib/types';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Products · OutreachGraph' };

/**
 * Everything this workspace sells, on one page.
 *
 * The multi-product layer already existed — each offering owns its claims, its
 * ICP, its voice and its campaign — but it was only reachable as a row of
 * pills inside the setup *form*. You had to already be editing one product to
 * discover that a second was possible, which is a feature nobody finds.
 *
 * So the list gets its own route and its own entry in More. The form stays
 * where it is: this page routes to `/setup?product=<id>` rather than
 * re-implementing the editor, and archiving stays on that page too, beside the
 * confirm prompt and the error handling that already exist there. Two places
 * that can archive a product is how the two of them drift.
 */
export default async function ProductsPage() {
  let products: ProductSummaryView[] = [];
  let offline = false;

  try {
    products = await fetchProducts();
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    if (error instanceof ApiUnavailableError) offline = true;
    else throw error;
  }

  // The placeholder offering a first campaign bootstraps is not a product
  // anyone chose to sell, and listing "Unconfigured offering" as though it
  // were makes an empty workspace read as a full one.
  const configured = products.filter((product) => product.configured);

  return (
    <div className="pt-4">
      <header className="mb-4">
        <h1 className="text-xl font-semibold">Products</h1>
        <p className="text-ink-muted text-sm">
          Each one gets its own buyers, its own voice and its own campaign.
        </p>
      </header>

      <PageGuide page="products" />

      {offline ? (
        <p className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
          Waiting for the API.
        </p>
      ) : (
        <>
          {configured.length === 0 ? (
            <p className="border-border text-ink-muted mb-4 rounded-2xl border border-dashed p-8 text-center text-sm">
              Nothing described yet. Add what you sell and every draft can quote it.
            </p>
          ) : (
            <ul className="border-border divide-border mb-4 divide-y overflow-hidden rounded-2xl border">
              {configured.map((product) => (
                <li key={product.offeringId}>
                  <Link
                    href={`/setup?product=${encodeURIComponent(product.offeringId)}`}
                    className="bg-surface-raised block p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-medium">{product.name}</div>
                        <div className="text-ink-muted truncate text-xs">
                          {product.url ?? product.category}
                        </div>
                      </div>

                      <div className="shrink-0 text-[11px]">
                        {product.campaignStatus === 'archived' ? (
                          <span className="text-ink-muted">archived</span>
                        ) : product.campaignId ? (
                          <span className="text-accent">
                            {product.autopilot ? 'autopilot' : 'campaign'}
                          </span>
                        ) : (
                          <span className="text-ink-muted">no campaign</span>
                        )}
                      </div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}

          <Link
            href="/setup?product=new"
            className="border-border text-ink-muted block rounded-2xl border border-dashed p-4 text-center text-sm"
          >
            + Add a product
          </Link>
        </>
      )}

      <p className="text-ink-muted mt-6 text-center text-xs">
        <Link href="/more" className="underline">
          Back to More
        </Link>
      </p>
    </div>
  );
}

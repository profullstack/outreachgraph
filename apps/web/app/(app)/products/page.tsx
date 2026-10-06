import { redirect } from 'next/navigation';
import { BulkProductIntake } from '../../../components/bulk-product-intake';
import { PageGuide } from '../../../components/page-guide';
import { ProductTable, type ProductRowView } from '../../../components/product-table';
import {
  ApiUnavailableError,
  NotAuthenticatedError,
  fetchCampaignSummaries,
  fetchProducts,
  type CampaignSummaryView,
} from '../../../lib/api';
import type { ProductSummaryView } from '../../../lib/types';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Products · OutreachGraph' };

/**
 * Everything this workspace sells, and how each one is doing.
 *
 * The main screen for a workspace that runs many products. It used to be a
 * list of names that led to a settings form, with the numbers on a separate
 * campaign list and the way to add products folded inside the Outreach page.
 * Now it is one box to add products — one site or fifty — above a table of
 * every product with its leads, replies and waiting count. A row opens that
 * product's page.
 */
export default async function ProductsPage() {
  let products: ProductSummaryView[] = [];
  let campaigns: CampaignSummaryView[] = [];
  let offline = false;

  try {
    [products, campaigns] = await Promise.all([fetchProducts(), fetchCampaignSummaries()]);
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    if (error instanceof ApiUnavailableError) offline = true;
    else throw error;
  }

  const byId = new Map(campaigns.map((campaign) => [campaign.id, campaign]));

  // The placeholder offering a first campaign bootstraps is not a product
  // anyone chose to sell.
  const rows: ProductRowView[] = products
    .filter((product) => product.configured)
    .map((product) => {
      const campaign = product.campaignId ? byId.get(product.campaignId) : undefined;
      return {
        id: product.offeringId,
        name: product.name,
        host: product.url?.replace(/^https?:\/\//, '').replace(/\/$/, '') ?? null,
        leads: Number(campaign?.people ?? 0),
        replies: Number(campaign?.replied ?? 0),
        waiting: Number(campaign?.awaiting_approval ?? 0),
        working: Number(campaign?.jobs_pending ?? 0) > 0,
        autopilot: product.autopilot,
        status: product.campaignStatus,
      };
    });

  return (
    <div className="pt-4">
      <header className="mb-4">
        <h1 className="text-xl font-semibold">Products</h1>
        <p className="text-ink-muted text-sm">
          Each one has its own buyers, voice and campaign. Open one to see how it is doing.{' '}
          <a href="/jobs" className="underline">
            Job posts
          </a>{' '}
          finds the people behind hiring companies.{' '}
          <a href="/ideas" className="underline">
            Ideas
          </a>{' '}
          finds products people keep asking for, and builds one with chovy.com.
        </p>
      </header>

      <PageGuide page="products" />

      {offline ? (
        <p className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
          Waiting for the API.
        </p>
      ) : (
        <>
          {/* Open by default only while there is nothing to show below it. */}
          <details
            open={rows.length === 0}
            className="border-border bg-surface-raised mb-4 rounded-2xl border p-4"
          >
            <summary className="cursor-pointer text-sm font-medium">+ Add products</summary>
            <div className="mt-3">
              <BulkProductIntake />
            </div>
          </details>

          {rows.length === 0 ? (
            <p className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
              No products yet. Paste your site above and we take it from there.
            </p>
          ) : (
            <ProductTable rows={rows} />
          )}
        </>
      )}
    </div>
  );
}

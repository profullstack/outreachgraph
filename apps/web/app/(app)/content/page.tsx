import { redirect } from 'next/navigation';
import { ContentRadar, type RadarTab } from '../../../components/content-radar';
import { ContentStudio } from '../../../components/content-studio';
import {
  ApiUnavailableError,
  NotAuthenticatedError,
  fetchContentDrafts,
  fetchProducts,
  type ContentStudioView,
} from '../../../lib/api';
import type { ProductSummaryView } from '../../../lib/types';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Content · OutreachGraph' };

const RADAR_TABS: readonly RadarTab[] = ['discover', 'saved', 'following', 'studio'];

export default async function ContentPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;

  // Discover, Saved, Following and Studio load in the browser from
  // /api/v1/content-radar; Drafts is the long-form studio it always was.
  if (tab !== 'drafts') {
    const radarTab = RADAR_TABS.includes(tab as RadarTab) ? (tab as RadarTab) : 'discover';
    return <ContentRadar tab={radarTab} />;
  }

  let studio: ContentStudioView = { drafts: [], draftingEnabled: false };
  let products: ProductSummaryView[] = [];

  try {
    [studio, products] = await Promise.all([fetchContentDrafts(), fetchProducts()]);
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    if (!(error instanceof ApiUnavailableError)) throw error;
  }

  return (
    <div className="space-y-4">
      <ContentTabsBar />
      <ContentStudio initial={studio} products={products} />
    </div>
  );
}

function ContentTabsBar() {
  const tabs = [
    ['discover', 'Discover'],
    ['saved', 'Saved'],
    ['following', 'Following'],
    ['studio', 'Studio'],
    ['drafts', 'Drafts'],
  ] as const;
  return (
    <nav className="border-border flex gap-2 overflow-x-auto border-b pb-2 text-sm">
      {tabs.map(([value, label]) => (
        <a
          key={value}
          href={`/content?tab=${value}`}
          aria-current={value === 'drafts' ? 'page' : undefined}
          className={`shrink-0 rounded-full border px-3 py-1.5 ${
            value === 'drafts'
              ? 'border-accent bg-accent text-white'
              : 'border-border text-ink-muted'
          }`}
        >
          {label}
        </a>
      ))}
    </nav>
  );
}

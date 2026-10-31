import { redirect } from 'next/navigation';
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
export const metadata = { title: 'Content studio · OutreachGraph' };

export default async function ContentPage() {
  let studio: ContentStudioView = { drafts: [], draftingEnabled: false };
  let products: ProductSummaryView[] = [];

  try {
    [studio, products] = await Promise.all([fetchContentDrafts(), fetchProducts()]);
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    if (!(error instanceof ApiUnavailableError)) throw error;
  }

  return <ContentStudio initial={studio} products={products} />;
}

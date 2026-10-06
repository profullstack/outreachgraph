import { redirect } from 'next/navigation';
import { IdeasBoard } from '../../../components/ideas-board';
import {
  ApiUnavailableError,
  NotAuthenticatedError,
  fetchIdeas,
  type IdeasView,
} from '../../../lib/api';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Ideas · OutreachGraph' };

/**
 * Products people keep asking for.
 *
 * Reddit posts of people asking for a site, app or tool, grouped by what they
 * want and ranked by how many different people asked. When enough have, Build
 * it hands the idea to chovy.com, which builds and ships it on our own stack.
 */
export default async function IdeasPage() {
  let view: IdeasView | undefined;
  try {
    view = await fetchIdeas();
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    if (!(error instanceof ApiUnavailableError)) throw error;
  }

  return (
    <div className="pt-4">
      <header className="mb-4">
        <h1 className="text-xl font-semibold">Ideas</h1>
        <p className="text-ink-muted text-sm">
          What people keep asking someone to build. When enough different people ask, build it.
        </p>
      </header>

      {view ? (
        <IdeasBoard initial={view} />
      ) : (
        <p className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
          Waiting for the API.
        </p>
      )}
    </div>
  );
}

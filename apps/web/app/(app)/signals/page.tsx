import { redirect } from 'next/navigation';
import { PageGuide } from '../../../components/page-guide';
import { SignalFeed } from '../../../components/signal-feed';
import { ApiUnavailableError, NotAuthenticatedError, fetchSignalPage } from '../../../lib/api';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Signals · OutreachGraph' };

/** The signal feed (PRD §25.3) — the screen intended to become habit-forming. */
export default async function SignalsPage() {
  let page;

  try {
    page = await fetchSignalPage();
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    if (error instanceof ApiUnavailableError) {
      return <p className="text-ink-muted pt-8 text-center text-sm">The API is not reachable.</p>;
    }
    throw error;
  }

  return (
    <div className="pt-4">
      <header className="mb-4">
        <h1 className="text-xl font-semibold">Signals</h1>
        <p className="text-ink-muted text-sm">
          Recent public activity: refine by relevance, tone and network, then export
        </p>
      </header>

      <PageGuide page="signals" />

      <SignalFeed initial={page.signals} initialCursor={page.nextCursor} />
    </div>
  );
}

import { redirect } from 'next/navigation';
import { PageGuide } from '../../../components/page-guide';
import {
  ApiUnavailableError,
  NotAuthenticatedError,
  fetchSignals,
  relativeTime,
} from '../../../lib/api';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Signals · OutreachGraph' };

/** The signal feed (PRD §25.3) — the screen intended to become habit-forming. */
export default async function SignalsPage() {
  let signals;

  try {
    signals = await fetchSignals();
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
        <p className="text-ink-muted text-sm">Recent public activity, newest first</p>
      </header>

      <PageGuide page="signals" />

      {signals.length === 0 ? (
        <p className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
          No signals collected yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {signals.map((signal) => (
            <li key={signal.id} className="border-border bg-surface-raised rounded-2xl border p-4">
              <div className="flex items-center gap-2">
                {signal.relevance >= 0.8 ? (
                  <span className="text-hot text-[11px] font-semibold tracking-wide uppercase">
                    High intent
                  </span>
                ) : null}
                <span className="text-ink-muted text-xs">{signal.network}</span>
                <span className="text-ink-muted text-xs">
                  · {relativeTime(signal.source_timestamp)}
                </span>
              </div>

              <p className="mt-1 font-medium">{signal.display_name ?? 'Unattributed'}</p>
              <p className="mt-1 text-sm">{signal.summary}</p>

              {signal.source_url ? (
                <a
                  className="text-accent mt-2 inline-block text-xs underline"
                  href={signal.source_url}
                  rel="noreferrer"
                >
                  View source
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

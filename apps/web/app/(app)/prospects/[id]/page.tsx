import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  ApiUnavailableError,
  NotAuthenticatedError,
  fetchProspect,
  relativeTime,
} from '../../../../lib/api';
import type { ProspectDetail } from '../../../../lib/types';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Prospect · OutreachGraph' };

/**
 * One prospect: who we think they are, and what we can prove (PRD §25.3).
 *
 * Identities carry their confidence and signals carry their source link,
 * because the product's claim is not "we found this person" but "here is why
 * we believe it" — a reviewer who cannot check the evidence cannot approve
 * anything responsibly.
 */
export default async function ProspectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let detail: ProspectDetail;

  try {
    detail = await fetchProspect(id);
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    if (error instanceof ApiUnavailableError) {
      return (
        <p className="text-ink-muted pt-8 text-center text-sm">
          The API is not reachable right now.
        </p>
      );
    }
    notFound();
  }

  const { person, identities, signals } = detail;
  // Tolerated as possibly-absent: a browser holding a cached page from before
  // company profiles existed would otherwise crash on `.length`.
  const companyIdentities = detail.companyIdentities ?? [];

  return (
    <div className="pt-4 pb-8">
      <Link href="/prospects" className="text-ink-muted text-sm">
        ← Prospects
      </Link>

      <header className="mt-3">
        <h1 className="text-xl font-semibold">{person.display_name}</h1>
        <p className="text-ink-muted text-sm">{person.current_title ?? '—'}</p>
        <p className="text-ink-muted mt-1 text-xs">
          Identity confidence {Math.round((person.identity_confidence ?? 0) * 100)}%
        </p>
      </header>

      <section className="mt-6">
        <h2 className="text-ink-muted text-[11px] font-semibold tracking-wide uppercase">
          Identities
        </h2>
        {identities.length ? (
          <ul className="mt-2 flex flex-col gap-2">
            {identities.map((identity) => (
              <li
                key={identity.id}
                className="border-border bg-surface-raised flex items-center justify-between gap-3 rounded-xl border p-3"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{identity.handle}</div>
                  <div className="text-ink-muted text-xs">{identity.network}</div>
                </div>
                <span className="text-good shrink-0 text-sm tabular-nums">
                  {identity.confidence.toFixed(2)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ink-muted mt-2 text-sm">No linked identities.</p>
        )}
      </section>

      {/* Their employer's profiles, in a section of their own.
          Separate from the list above because they are a way to reach the
          company, not a claim that this person holds the account — and on a
          site that names its staff but links only its own accounts, which is
          most of them, this is the only social route there is. */}
      {companyIdentities.length ? (
        <section className="mt-6">
          <h2 className="text-ink-muted text-[11px] font-semibold tracking-wide uppercase">
            Company profiles
          </h2>
          <p className="text-ink-muted mt-1 text-xs">
            Published by {companyIdentities[0]?.company_name ?? 'their employer'}, not by this
            person.
          </p>
          <ul className="mt-2 flex flex-col gap-2">
            {companyIdentities.map((identity) => (
              <li
                key={identity.id}
                className="border-border bg-surface-raised flex items-center justify-between gap-3 rounded-xl border p-3"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {identity.profile_url ? (
                      <a
                        href={identity.profile_url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-accent underline"
                      >
                        {identity.handle ?? identity.profile_url}
                      </a>
                    ) : (
                      (identity.handle ?? '—')
                    )}
                  </div>
                  <div className="text-ink-muted text-xs">{identity.network}</div>
                </div>
                <span className="text-good shrink-0 text-sm tabular-nums">
                  {identity.confidence.toFixed(2)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mt-6">
        <h2 className="text-ink-muted text-[11px] font-semibold tracking-wide uppercase">
          Signals
        </h2>
        {signals.length ? (
          <ul className="mt-2 flex flex-col gap-2">
            {signals.map((signal) => (
              <li
                key={signal.id}
                className="border-hot/40 bg-hot/5 rounded-xl border-l-2 px-3 py-2"
              >
                <p className="text-sm">{signal.summary}</p>
                <p className="text-ink-muted mt-1 text-xs">
                  {signal.signal_type.replace(/_/g, ' ')} · {relativeTime(signal.source_timestamp)}
                  {signal.source_url ? (
                    <>
                      {' · '}
                      <a
                        className="text-accent underline"
                        href={signal.source_url}
                        rel="noreferrer"
                      >
                        source
                      </a>
                    </>
                  ) : null}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ink-muted mt-2 text-sm">
            No signals captured yet. Nothing personalised can be written without them.
          </p>
        )}
      </section>
    </div>
  );
}

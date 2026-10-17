import { redirect } from 'next/navigation';
import {
  ApiUnavailableError,
  NotAuthenticatedError,
  fetchLeadSources,
  type LeadBaseView,
} from '../../../lib/api';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Lead sources · OutreachGraph' };

function when(value: string | null): string {
  if (!value) return '-';
  return value.replace('T', ' ').slice(0, 16) + ' UTC';
}

function count(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * The lead base: companies imported from open lists, per source.
 *
 * Importing a company is free (a name, a domain, a country, where it came
 * from); finding its people is the paid step, and runs only for companies a
 * campaign picks (`og sources pick`, or the MCP tool `pick_imported_leads`).
 */
export default async function SourcesPage() {
  let view: LeadBaseView | undefined;
  try {
    view = await fetchLeadSources();
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    if (!(error instanceof ApiUnavailableError)) throw error;
  }

  return (
    <div className="pt-4">
      <header className="mb-4">
        <h1 className="text-xl font-semibold">Lead sources</h1>
        <p className="text-ink-muted text-sm">
          Companies imported from open lists, each source on its own daily cap. Importing costs
          nothing; people are looked up only for the companies a campaign picks.
        </p>
      </header>

      {view ? (
        <>
          <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ['Companies', view.totals.companies],
              ['Imported', view.totals.imported],
              ['People', view.totals.people],
              ['With an email', view.totals.peopleWithEmail],
            ].map(([label, n]) => (
              <div key={String(label)} className="border-border rounded-2xl border p-3">
                <dt className="text-ink-muted text-xs">{label}</dt>
                <dd className="text-lg font-semibold tabular-nums">{count(Number(n))}</dd>
              </div>
            ))}
          </dl>
          <p className="text-ink-muted mb-3 text-xs">
            {count(view.totals.addedToday)} of {count(view.totals.dailyTotal)} imported today across
            all sources.
          </p>
          <ul className="space-y-2">
            {view.sources.map((s) => (
              <li key={s.id} className="border-border rounded-2xl border p-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <a href={s.homepage} className="font-medium underline-offset-2 hover:underline">
                    {s.label}
                  </a>
                  <span className="text-ink-muted text-xs">
                    {s.enabled ? 'on' : 'paused'} · {s.license}
                  </span>
                </div>
                <p className="mt-1 tabular-nums">
                  {count(s.companies)} companies · {count(s.addedToday)}/{count(s.dailyCap)} today
                </p>
                <p className="text-ink-muted text-xs">
                  Last run {when(s.lastRunAt)}
                  {s.lastAdded !== null ? ` (+${count(s.lastAdded)})` : ''} · next{' '}
                  {when(s.nextRunAt)}
                  {s.exhaustedAt ? ` · reached the end ${when(s.exhaustedAt)}` : ''}
                </p>
                {s.lastError ? <p className="mt-1 text-xs text-red-600">{s.lastError}</p> : null}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
          Waiting for the API.
        </p>
      )}
    </div>
  );
}

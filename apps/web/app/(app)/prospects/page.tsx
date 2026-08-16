import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ApiUnavailableError, NotAuthenticatedError, fetchProspects } from '../../../lib/api';
import type { ProspectRow } from '../../../lib/types';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Prospects · OutreachGraph' };

/**
 * Prospects — everyone in the workspace, ranked by opportunity (PRD §25.2).
 *
 * The add form sits above the list rather than behind a button because on a
 * new account this page is the only thing standing between an empty product
 * and a working one.
 */
export default async function ProspectsPage() {
  let people: ProspectRow[] = [];
  let offline = false;

  try {
    people = await fetchProspects();
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    if (error instanceof ApiUnavailableError) offline = true;
    else throw error;
  }

  return (
    <div className="pt-4">
      <header className="mb-4">
        <h1 className="text-xl font-semibold">Prospects</h1>
        <p className="text-ink-muted text-sm">
          {offline ? 'Waiting for the API' : `${people.length} in this workspace`}
        </p>
      </header>

      {/* Intake lives on Outreach, in one box that takes a website or a
          description of a market. The GitHub-handle form that used to sit here
          is gone: asking a salesperson for a GitHub username to start a sales
          campaign was the single strangest thing about this product. GitHub is
          still read as a signal source, which is where it belongs. */}
      <Link href="/outreach" className="border-accent/40 bg-accent/5 block rounded-2xl border p-4">
        <span className="text-sm font-medium">Start a campaign</span>
        <span className="text-ink-muted mt-1 block text-[13px] leading-relaxed">
          Enter a company website, or describe who you want to reach.
        </span>
      </Link>

      {people.length > 0 ? (
        <ul className="mt-4 flex flex-col gap-2">
          {people.map((person) => (
            <ProspectItem key={person.id} person={person} />
          ))}
        </ul>
      ) : !offline ? (
        <p className="border-border text-ink-muted mt-4 rounded-2xl border border-dashed p-8 text-center text-sm">
          No prospects yet. Start a campaign on the <Link href="/outreach">Outreach</Link> tab and
          the pipeline will find people, resolve who they are, collect signals and score them.
        </p>
      ) : null}
    </div>
  );
}

function ProspectItem({ person }: { person: ProspectRow }) {
  const subtitle = [person.current_title, person.current_company].filter(Boolean).join(' · ');

  return (
    <li>
      <Link
        href={`/prospects/${person.id}`}
        className="border-border bg-surface-raised block rounded-2xl border p-4"
      >
        <div className="flex items-baseline justify-between gap-3">
          <span className="truncate font-semibold">{person.display_name}</span>
          <span className="text-accent shrink-0 font-semibold tabular-nums">
            {person.opportunity ?? '—'}
          </span>
        </div>

        <p className="text-ink-muted mt-1 truncate text-sm">{subtitle || '—'}</p>

        <dl className="text-ink-muted mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <div className="flex gap-1">
            <dt>Signals</dt>
            <dd className="text-ink font-medium tabular-nums">{person.signal_count}</dd>
          </div>
          <div className="flex gap-1">
            <dt>Identity</dt>
            <dd className="text-ink font-medium tabular-nums">
              {Math.round((person.identity_confidence ?? 0) * 100)}%
            </dd>
          </div>
          <div className="flex gap-1">
            <dt>Status</dt>
            <dd className="text-ink font-medium">{person.prospect_status.replace(/_/g, ' ')}</dd>
          </div>
        </dl>
      </Link>
    </li>
  );
}

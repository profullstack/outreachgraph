import Link from 'next/link';
import { redirect } from 'next/navigation';
import { CadenceBuilder } from '../../../components/cadence-builder';
import { CadenceStatus } from '../../../components/cadence-status';
import {
  ApiUnavailableError,
  NotAuthenticatedError,
  fetchCadences,
  fetchPlaybooks,
  type CadenceRowView,
  type PlaybookRowView,
} from '../../../lib/api';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Plans · OutreachGraph' };

/**
 * Cadences: an ordered plan of touches over time.
 *
 * Called "Plans" in the interface rather than "cadences" or "sequences".
 * Both of those are words this industry uses and neither is a word a person
 * reaches for unprompted, and the screen has enough to explain without
 * spending its first line on vocabulary.
 */
export default async function CadencesPage() {
  let cadences: CadenceRowView[] = [];
  let playbooks: PlaybookRowView[] = [];
  let offline = false;

  try {
    [cadences, playbooks] = await Promise.all([fetchCadences(), fetchPlaybooks()]);
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    if (error instanceof ApiUnavailableError) offline = true;
    else throw error;
  }

  return (
    <div className="pt-4">
      <header className="mb-4">
        <h1 className="text-xl font-semibold">Plans</h1>
        <p className="text-ink-muted text-sm">
          A sequence of touches over days, not one message and silence.
        </p>
      </header>

      {offline ? (
        <p className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
          Waiting for the API.
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          {cadences.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {cadences.map((cadence) => (
                <li
                  key={cadence.id}
                  className="border-border bg-surface-raised rounded-2xl border p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link href={`/cadences/${cadence.id}`} className="font-medium">
                        {cadence.name}
                      </Link>
                      <div className="text-ink-muted mt-0.5 text-xs">
                        {cadence.steps} {cadence.steps === 1 ? 'step' : 'steps'} ·{' '}
                        {cadence.active_enrollments} active
                      </div>
                    </div>

                    <StatusPill status={cadence.status} />
                  </div>

                  <div className="mt-3">
                    <CadenceStatus id={cadence.id} status={cadence.status} />
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="border-border text-ink-muted rounded-2xl border border-dashed p-6 text-center text-sm">
              No plans yet. Start from one below — they run as they are.
            </p>
          )}

          <CadenceBuilder playbooks={playbooks} />

          <section className="border-border rounded-2xl border border-dashed p-4">
            <h2 className="text-sm font-semibold">How a step is decided</h2>
            <p className="text-ink-muted mt-2 text-xs leading-relaxed">
              Each step names a network and an action. When it falls due we ask the policy engine
              what is permitted <em>then</em> — so the same plan sends by itself on a network that
              allows it, and becomes a one-tap job for you on one that does not. Both are counted
              the same way in the funnel, which is the part most tools get wrong.
            </p>
            <p className="text-ink-muted mt-2 text-xs leading-relaxed">
              A reply ends the plan. Continuing to work through a sequence at somebody who has
              already answered is the most machine-like thing this product could do.
            </p>
          </section>
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'active'
      ? 'bg-emerald-500/15 text-emerald-600'
      : status === 'paused'
        ? 'bg-amber-500/15 text-amber-600'
        : status === 'archived'
          ? 'bg-ink-muted/10 text-ink-muted'
          : 'bg-sky-500/15 text-sky-600';

  return (
    <span className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-medium ${tone}`}>
      {status}
    </span>
  );
}

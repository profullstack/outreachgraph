import Link from 'next/link';
import { ActivityLine } from './activity-line';
import { PIPELINE, loadGuide, type NextAction, type PageId } from '../lib/guide';

/**
 * The inline instructions that sit on every signed-in screen.
 *
 * Three questions, always in the same order, because that is the order they get
 * asked in: where am I in the process, is anything happening, and what do I do
 * next. Everything below that fold is reference and lives behind a disclosure —
 * a panel that pushes the actual page off the screen stops being read, and an
 * unread instruction is the same as no instruction.
 *
 * The action items are the load-bearing part. They are computed from live
 * workspace state in `lib/guide`, so the panel goes quiet on a workspace that
 * is fully set up rather than nagging about a mailbox that is already
 * connected.
 */
export async function PageGuide({
  page,
  /**
   * Today renders the full `LiveStatus` panel immediately below this one.
   * Repeating the line there would both duplicate the sentence and open a
   * second `EventSource` on one page.
   */
  live = true,
  /**
   * Action ids this page already handles with a dedicated control.
   *
   * Two prompts for one job is worse than none: the reader does the thing,
   * watches half the advice disappear, and stops trusting the rest. It also
   * covers items that would link to the page being read.
   */
  suppress = [],
}: {
  page: PageId;
  live?: boolean;
  suppress?: readonly string[];
}) {
  const guide = await loadGuide(page);
  const { copy, stepIndex } = guide;
  const actions = guide.actions.filter((action) => !suppress.includes(action.id));

  const chip =
    stepIndex >= 0
      ? `Step ${stepIndex + 1} of ${PIPELINE.length} · ${PIPELINE[stepIndex]?.label}`
      : (copy.chip ?? 'Overview');

  return (
    <section
      aria-label="How this page works"
      className="border-border bg-surface-raised mb-4 rounded-2xl border p-4"
    >
      <p className="text-ink-muted text-[11px] font-semibold tracking-wide uppercase">{chip}</p>
      <p className="mt-1 text-[13px] leading-relaxed">{copy.what}</p>

      {live ? (
        <div className="border-border mt-3 border-t pt-3">
          <ActivityLine
            {...(guide.status ? { initialStatus: guide.status } : {})}
            {...(guide.started
              ? {}
              : {
                  idleHint: 'Nothing running yet. Start a campaign and this fills in as it works.',
                })}
          />
        </div>
      ) : null}

      <div className="border-border mt-3 border-t pt-3">
        <h2 className="text-ink-muted text-[11px] font-semibold tracking-wide uppercase">
          Do next
        </h2>

        {!guide.reachable ? (
          <p className="text-ink-muted mt-1.5 text-[13px]">
            The API is not reachable, so there is nothing reliable to advise.
          </p>
        ) : actions.length === 0 ? (
          // A workspace with nothing outstanding is a real state and deserves
          // to be said out loud. Silence here reads as a panel that failed.
          <p className="text-ink-muted mt-1.5 text-[13px] leading-relaxed">
            Nothing needs you right now. New drafts appear on{' '}
            <Link href="/approvals" className="underline">
              Approvals
            </Link>{' '}
            as signals arrive.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {actions.map((action) => (
              <ActionItem key={action.id} action={action} />
            ))}
          </ul>
        )}
      </div>

      <details className="border-border mt-3 border-t pt-3">
        <summary className="cursor-pointer text-[13px] font-medium">
          How the whole thing works
        </summary>

        <dl className="mt-3 flex flex-col gap-2 text-[13px] leading-relaxed">
          <div className="flex gap-2">
            <dt className="text-ink-muted w-20 shrink-0">Your part</dt>
            <dd className="min-w-0">{copy.you}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-ink-muted w-20 shrink-0">Ours</dt>
            <dd className="min-w-0">{copy.ours}</dd>
          </div>
        </dl>

        {copy.note ? (
          <p className="border-accent/40 text-ink-muted mt-3 border-l-2 pl-3 text-[13px] leading-relaxed">
            {copy.note}
          </p>
        ) : null}

        <ol className="mt-4 flex flex-col gap-3">
          {PIPELINE.map((step, index) => {
            const current = index === stepIndex;

            return (
              <li key={step.id} className="flex gap-3">
                <span
                  className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums ${
                    current ? 'bg-accent text-white' : 'border-border text-ink-muted border'
                  }`}
                >
                  {index + 1}
                </span>

                <div className="min-w-0">
                  <p className="text-[13px] font-medium">
                    {step.href ? (
                      <Link href={step.href} className="underline">
                        {step.label}
                      </Link>
                    ) : (
                      step.label
                    )}
                    {step.automatic ? (
                      <span className="text-ink-muted font-normal"> · runs by itself</span>
                    ) : null}
                    {current ? (
                      <span className="text-accent font-normal"> · you are here</span>
                    ) : null}
                  </p>
                  <p className="text-ink-muted mt-0.5 text-[13px] leading-relaxed">{step.blurb}</p>
                </div>
              </li>
            );
          })}
        </ol>
      </details>
    </section>
  );
}

/**
 * One thing to do, as a link to where it is done.
 *
 * Blocking items are marked rather than merely ordered first: "optional" and
 * "nothing works until you do this" are not a difference of degree, and a
 * reader skimming a list of four will otherwise start at the top and stop.
 */
function ActionItem({ action }: { action: NextAction }) {
  return (
    <li>
      <Link
        href={action.href}
        className={`block rounded-xl border p-3 ${
          action.blocking ? 'border-accent/40 bg-accent/5' : 'border-border'
        }`}
      >
        <span className="flex items-baseline justify-between gap-2">
          <span className="text-[13px] font-medium">{action.label}</span>
          {action.blocking ? (
            <span className="text-accent shrink-0 text-[11px] font-semibold tracking-wide uppercase">
              Required
            </span>
          ) : null}
        </span>
        <span className="text-ink-muted mt-0.5 block text-[13px] leading-relaxed">
          {action.detail}
        </span>
      </Link>
    </li>
  );
}

import { relativeTime, type ApprovalCard as Card } from '../lib/api';

/**
 * The approval card (PRD §15).
 *
 * Order is deliberate: who, then why now, then what we propose, then the
 * words — so the reviewer forms a judgement about the evidence before reading
 * a draft that might read persuasively regardless.
 */
export function ApprovalCard({ card }: { card: Card }) {
  return (
    <article className="border-border bg-surface-raised rounded-2xl border p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold">{card.display_name}</h2>
          <p className="text-ink-muted truncate text-sm">{card.current_title ?? '—'}</p>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-accent text-lg leading-none font-semibold tabular-nums">
            {card.opportunity ?? '—'}
          </div>
          <div className="text-ink-muted text-[11px]">opportunity</div>
        </div>
      </header>

      <dl className="text-ink-muted mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <div className="flex gap-1">
          <dt>Identity</dt>
          <dd className="text-ink font-medium tabular-nums">
            {Math.round(card.identity_confidence * 100)}%
          </dd>
        </div>
        <div className="flex gap-1">
          <dt>Channel</dt>
          <dd className="text-ink font-medium">{card.network}</dd>
        </div>
      </dl>

      {card.signal_summary ? (
        <section className="border-hot/40 bg-hot/5 mt-4 rounded-xl border-l-2 p-3">
          <h3 className="text-hot text-[11px] font-semibold tracking-wide uppercase">Why now</h3>
          <p className="mt-1 text-sm">{card.signal_summary}</p>
          <p className="text-ink-muted mt-1 text-xs">
            {relativeTime(card.signal_at)}
            {card.signal_url ? (
              <>
                {' · '}
                <a className="text-accent underline" href={card.signal_url} rel="noreferrer">
                  source
                </a>
              </>
            ) : null}
          </p>
        </section>
      ) : null}

      <section className="mt-4">
        <h3 className="text-ink-muted text-[11px] font-semibold tracking-wide uppercase">
          Recommended
        </h3>
        <p className="mt-1 text-sm">
          <span className="font-medium capitalize">{card.action.replace(/_/g, ' ')}</span>
          {' — '}
          {card.reason}
        </p>
      </section>

      {card.draft_body ? (
        <section className="mt-4">
          <h3 className="text-ink-muted text-[11px] font-semibold tracking-wide uppercase">
            Draft
          </h3>
          <p className="border-border mt-1 rounded-xl border p-3 text-sm whitespace-pre-wrap">
            {card.draft_body}
          </p>
        </section>
      ) : null}

      <div className="mt-4 grid grid-cols-2 gap-2">
        <button type="button" className="bg-accent rounded-xl text-sm font-medium text-white">
          Approve
        </button>
        <button type="button" className="border-border rounded-xl border text-sm font-medium">
          Edit
        </button>
        <button type="button" className="border-border rounded-xl border text-sm font-medium">
          Skip
        </button>
        <button
          type="button"
          className="border-border text-hot rounded-xl border text-sm font-medium"
        >
          Do not contact
        </button>
      </div>
    </article>
  );
}

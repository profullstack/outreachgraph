/**
 * The label triage gave a reply, as a chip.
 *
 * The colour carries the one thing a reader scans for: is this someone to
 * answer (accent), someone who said no or asked to stop (hot), or a machine
 * (muted). The source and confidence ride along in the title so a reviewer can
 * tell a rule's certainty from a model's guess without the chip shouting it.
 */

const TONE: Record<string, string> = {
  interested: 'border-good/40 text-good',
  question: 'border-accent/40 text-accent',
  referral: 'border-accent/40 text-accent',
  not_interested: 'border-hot/40 text-hot',
  unsubscribe_request: 'border-hot/40 text-hot',
  out_of_office: 'border-border text-ink-muted',
  bounce: 'border-border text-ink-muted',
  other: 'border-border text-ink-muted',
};

const WORDS: Record<string, string> = {
  interested: 'Interested',
  question: 'Question',
  referral: 'Referral',
  not_interested: 'Not interested',
  unsubscribe_request: 'Unsubscribe',
  out_of_office: 'Out of office',
  bounce: 'Bounced',
  other: 'Other',
};

export function ReplyLabelChip({
  label,
  confidence,
  source,
  reason,
}: {
  label: string;
  confidence?: number | null;
  source?: string | null;
  reason?: string | null;
}) {
  const percent = typeof confidence === 'number' ? Math.round(confidence * 100) : undefined;
  const title = [
    source === 'rule' ? 'Matched a rule' : source === 'model' ? 'Classified by the model' : '',
    percent !== undefined && source !== 'rule' ? `${percent}% confident` : '',
    reason ?? '',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <span
      title={title || undefined}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
        TONE[label] ?? TONE.other
      }`}
    >
      {WORDS[label] ?? label}
      {percent !== undefined && source === 'model' ? (
        <span className="opacity-70 tabular-nums">{percent}%</span>
      ) : null}
    </span>
  );
}

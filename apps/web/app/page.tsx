import Link from 'next/link';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'OutreachGraph — turn public intent signals into warm conversations',
  description:
    'Find where your prospects are actually active, understand what they care about right now, and get the right moment to engage. Policy-aware, source-backed, human-approved.',
};

/**
 * The public landing page (PRD §44).
 *
 * Signed-in visitors are sent to their inbox rather than shown marketing. The
 * check is cookie presence only — a cheap test that avoids an API round trip
 * on every visit. A stale cookie simply lands on /today, which redirects to
 * /login itself, so nothing is trusted here beyond routing.
 */
export default async function LandingPage() {
  const jar = await cookies();
  if (jar.get('og_session')) redirect('/today');

  return (
    <div className="pb-12">
      <Hero />
      <IdentitySection />
      <WhyNowSection />
      <ControlSection />
      <SafetySection />
      <ClosingCta />
    </div>
  );
}

function Hero() {
  return (
    <section className="pt-10">
      <p className="text-accent text-xs font-semibold tracking-widest uppercase">OutreachGraph</p>

      <h1 className="mt-3 text-3xl leading-tight font-semibold tracking-tight sm:text-4xl">
        Stop cold emailing.
        <br />
        Start warm conversations.
      </h1>

      <p className="text-ink-muted mt-4 text-base leading-relaxed">
        Find where your prospects actually spend time online, understand what they care about right
        now, and let the system recommend the right moment to engage.
      </p>

      <div className="mt-6 flex flex-col gap-2 sm:flex-row">
        <Link
          href="/login"
          className="bg-accent flex items-center justify-center rounded-xl px-5 py-3 text-sm font-medium text-white"
        >
          Find my first 100 prospects
        </Link>
        <Link
          href="/login"
          className="border-border flex items-center justify-center rounded-xl border px-5 py-3 text-sm font-medium"
        >
          Sign in
        </Link>
      </div>

      <p className="text-ink-muted mt-4 text-xs">
        Apollo finds their contact info. OutreachGraph finds where they actually live online — and
        tells you how to start the conversation.
      </p>
    </section>
  );
}

function IdentitySection() {
  const networks = ['LinkedIn', 'GitHub', 'X', 'Bluesky', 'Reddit', 'YouTube', 'Web'];

  return (
    <Section title="One person. Many identities. One graph.">
      <p className="text-ink-muted text-sm leading-relaxed">
        The same human is a GitHub handle, an X account, a personal domain and a job title.
        OutreachGraph links them with stored evidence and a confidence score — and refuses to merge
        on a guess.
      </p>

      <ul className="mt-4 flex flex-wrap gap-2">
        {networks.map((network) => (
          <li
            key={network}
            className="border-border bg-surface-raised rounded-full border px-3 py-1 text-xs"
          >
            {network}
          </li>
        ))}
      </ul>

      <div className="border-border bg-surface-raised mt-4 rounded-2xl border p-4">
        <div className="text-ink-muted mb-2 text-[11px] font-semibold tracking-wide uppercase">
          A real resolution
        </div>
        <dl className="flex flex-col gap-1 font-mono text-xs">
          <Row label="github" value="janesmith" score="1.00" />
          <Row label="x" value="janesmith" score="0.96" />
          <Row label="website" value="jane.dev" score="0.92" />
        </dl>
        <p className="text-ink-muted mt-3 text-xs">
          Linked from what she published herself — not from a name match.
        </p>
      </div>
    </Section>
  );
}

function Row({ label, value, score }: { label: string; value: string; score: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-ink-muted w-16 shrink-0">{label}</dt>
      <dd className="flex-1 truncate">{value}</dd>
      <dd className="text-good tabular-nums">{score}</dd>
    </div>
  );
}

function WhyNowSection() {
  const quotes = [
    'Anyone know a good alternative to…',
    'We just migrated off…',
    'This API is killing us.',
    'We’re hiring a payments engineer.',
    'What do you use for…?',
  ];

  return (
    <Section title="Know why now.">
      <p className="text-ink-muted text-sm leading-relaxed">
        Public activity becomes structured intent. Every recommendation names the signal that
        triggered it, with a link to the source.
      </p>

      <ul className="mt-4 flex flex-col gap-2">
        {quotes.map((quote) => (
          <li
            key={quote}
            className="border-hot/40 bg-hot/5 rounded-xl border-l-2 px-3 py-2 text-sm italic"
          >
            “{quote}”
          </li>
        ))}
      </ul>
    </Section>
  );
}

function ControlSection() {
  const steps = ['Research', 'Score', 'Draft', 'Approve', 'Engage'];

  return (
    <Section title="AI that recommends. You stay in control.">
      <ol className="mt-1 flex flex-wrap items-center gap-2">
        {steps.map((step, index) => (
          <li key={step} className="flex items-center gap-2">
            <span className="border-border bg-surface-raised rounded-lg border px-3 py-1 text-xs font-medium">
              {step}
            </span>
            {index < steps.length - 1 ? <span className="text-ink-muted text-xs">→</span> : null}
          </li>
        ))}
      </ol>

      <p className="text-ink-muted mt-4 text-sm leading-relaxed">
        Nothing goes out without a human. Approval is the default, automation is opt-in, and the
        policy check runs again at the moment you approve — not when the card was created.
      </p>
    </Section>
  );
}

function SafetySection() {
  const guarantees = [
    [
      'Source-backed personalisation',
      'No stored evidence, no claim. The system will not invent a shared experience.',
    ],
    [
      'Platform-aware by construction',
      'Actions a network prohibits are unreachable, not merely discouraged.',
    ],
    [
      'Suppression that sticks',
      'Opting out leaves a tombstone that survives deletion, so no provider can re-ingest someone.',
    ],
    [
      'Precision over recall',
      'A wrong-person message costs more than a missed match, so weak evidence never merges.',
    ],
  ];

  return (
    <Section title="Built for conversations, not spam.">
      <dl className="mt-1 flex flex-col gap-3">
        {guarantees.map(([term, detail]) => (
          <div key={term} className="border-border rounded-xl border p-3">
            <dt className="text-sm font-medium">{term}</dt>
            <dd className="text-ink-muted mt-1 text-sm leading-relaxed">{detail}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

function ClosingCta() {
  return (
    <section className="border-border mt-10 rounded-2xl border border-dashed p-6 text-center">
      <h2 className="text-lg font-semibold">Find the people already talking about your problem.</h2>
      <p className="text-ink-muted mt-2 text-sm">
        Start with developer and technical buyers — the richest public signal there is.
      </p>
      <Link
        href="/login"
        className="bg-accent mt-4 inline-flex items-center justify-center rounded-xl px-5 py-3 text-sm font-medium text-white"
      >
        Get started
      </Link>
    </section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-border mt-10 border-t pt-8">
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

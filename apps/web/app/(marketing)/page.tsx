import Link from 'next/link';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { BrandLockup, BrandWordmark } from '../../components/brand';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'OutreachGraph — you don’t need more contacts, you need a reason to talk',
  description:
    'Find where your prospects are actually active, understand what they care about right now, and get the right moment to engage. Policy-aware, source-backed, human-approved.',
};

/**
 * The public landing page (PRD §44).
 *
 * The hero is the product's actual output rather than a description of it: an
 * approval card with a real quote, a source link and the recommended action.
 * Everything this product claims — grounded personalisation, a visible reason
 * to reach out, a human in the loop — is legible in that one artifact, and
 * showing it is more convincing than asserting it.
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
    <div>
      <SiteNav />
      <Hero />
      <EvidenceSection />
      <RefusalSection />
      <ClosingCta />
      <SiteFooter />
    </div>
  );
}

/** Content sits on one measure; bands paint full width around it. */
function Band({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <section className={className}>
      <div className="mx-auto w-full max-w-5xl px-5 sm:px-8">{children}</div>
    </section>
  );
}

function SiteNav() {
  return (
    <Band>
      <nav className="flex items-center justify-between py-5">
        <Link href="/" aria-label="OutreachGraph home">
          <BrandLockup size="md" />
        </Link>
        <Link
          href="/login"
          className="border-border rounded-xl border px-4 py-2.5 text-sm font-medium"
        >
          Sign in
        </Link>
      </nav>
    </Band>
  );
}

function Hero() {
  return (
    <Band className="pt-6 pb-14 sm:pt-10 sm:pb-20">
      <div className="grid items-center gap-10 lg:grid-cols-[1.05fr_1fr] lg:gap-14">
        <div>
          <p className="text-ink-muted font-mono text-[11px] tracking-[0.14em] uppercase">
            Signal-led outreach
          </p>

          <h1 className="mt-4 text-[38px] leading-[1.03] font-semibold tracking-[-0.035em] text-balance sm:text-[52px]">
            You don’t need more contacts. You need a reason to talk.
          </h1>

          <p className="text-ink-muted mt-5 max-w-[30em] text-[17px] leading-relaxed">
            Apollo finds their email. OutreachGraph finds the thing they said forty minutes ago that
            makes an email worth sending — and refuses to send anything the platform, the person, or
            your own limits say it shouldn’t.
          </p>

          <div className="mt-7 flex flex-col gap-3 sm:flex-row">
            <Link
              href="/login"
              className="bg-accent flex items-center justify-center rounded-xl px-6 py-3.5 text-sm font-medium text-white"
            >
              Find my first 100 prospects
            </Link>
            <Link
              href="/login"
              className="border-border flex items-center justify-center rounded-xl border px-6 py-3.5 text-sm font-medium"
            >
              Sign in
            </Link>
          </div>

          <p className="text-ink-muted mt-4 text-[13px]">
            Free while in beta · No card · Starts from a GitHub handle
          </p>
        </div>

        <ApprovalCardSample />
      </div>
    </Band>
  );
}

/**
 * A static replica of the real approval card.
 *
 * Deliberately not the live component: this one must render for a logged-out
 * stranger with no workspace, no prospect and no API call.
 */
function ApprovalCardSample() {
  return (
    <div className="border-border bg-surface rounded-2xl border p-5 shadow-[0_18px_50px_rgba(11,15,23,0.09)]">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="truncate text-base font-semibold">Alex Chen</div>
          <div className="text-ink-muted truncate text-[13.5px]">Staff Engineer · Loopwright</div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-accent font-mono text-xl leading-none font-semibold">92</div>
          <div className="text-ink-muted mt-1 text-[10.5px]">opportunity</div>
        </div>
      </div>

      <div className="border-hot/40 bg-hot/5 mt-4 rounded-r-xl border-l-2 px-3.5 py-3">
        <div className="text-hot font-mono text-[11px] tracking-[0.14em] uppercase">Why now</div>
        <p className="mt-2 text-[14.5px] leading-relaxed">
          “Anyone know a good alternative to Stripe for cross-border payouts? Fees are brutal and
          settlement takes days.”
        </p>
        <p className="text-ink-muted mt-2 text-xs">GitHub issue · 3 hours ago · source</p>
      </div>

      <div className="mt-4">
        <div className="text-ink-muted font-mono text-[11px] tracking-[0.14em] uppercase">
          Recommended
        </div>
        <p className="mt-1.5 text-[14.5px] leading-relaxed">
          <span className="font-semibold">Reply in thread</span> — he asked a direct question in
          public and the thread is still open.
        </p>
      </div>

      <div aria-hidden className="mt-5 flex gap-2">
        <div className="bg-accent flex-1 rounded-xl py-2.5 text-center text-[13.5px] font-medium text-white">
          Approve
        </div>
        <div className="border-border flex-1 rounded-xl border py-2.5 text-center text-[13.5px]">
          Edit
        </div>
        <div className="border-border text-ink-muted flex-1 rounded-xl border py-2.5 text-center text-[13.5px]">
          Skip
        </div>
      </div>
    </div>
  );
}

function EvidenceSection() {
  const identities = [
    ['github', '1.00', 'The handle you started from.'],
    ['x', '0.96', 'Linked from his own GitHub profile field.'],
    ['website', '0.92', 'Same domain in his bio and his commits.'],
  ];

  return (
    <Band className="bg-surface-raised border-border border-t py-16 sm:py-20">
      <h2 className="text-[28px] leading-tight font-semibold tracking-[-0.025em] text-balance sm:text-[34px]">
        Every claim traces back to something they published.
      </h2>
      <p className="text-ink-muted mt-4 max-w-[42em] text-[17px] leading-relaxed">
        No stored evidence, no claim. If the draft can’t point at a source it isn’t shown — the card
        keeps the prospect and the evidence, and you write the message yourself.
      </p>

      <ul className="mt-8 grid gap-4 sm:grid-cols-3">
        {identities.map(([network, confidence, detail]) => (
          <li key={network} className="border-border bg-surface rounded-2xl border p-5">
            <div className="text-good font-mono text-xs">{confidence}</div>
            <div className="mt-2 text-[15px] font-semibold">{network}</div>
            <p className="text-ink-muted mt-1.5 text-[13.5px] leading-relaxed">{detail}</p>
          </li>
        ))}
      </ul>

      <p className="text-ink-muted mt-6 text-[13.5px]">
        Linked from what he published himself — never from a name match. Two weak observations give
        0.75, not certainty.
      </p>
    </Band>
  );
}

function RefusalSection() {
  return (
    <Band className="py-16 sm:py-20">
      <div className="grid gap-10 lg:grid-cols-2 lg:gap-12">
        <div>
          <h2 className="text-[28px] leading-tight font-semibold tracking-[-0.025em] text-balance sm:text-[34px]">
            It will tell you no.
          </h2>
          <p className="text-ink-muted mt-4 text-[17px] leading-relaxed">
            The policy engine is arithmetic, not judgement. No model is in the loop, an unknown
            network is a deny, and LinkedIn automation isn’t discouraged — it’s unreachable. The
            check runs again when you approve, not when the card was made.
          </p>
        </div>

        <div className="border-border bg-surface-raised rounded-2xl border p-5 font-mono text-[12.5px] leading-loose">
          <div className="text-ink-muted">POST /recommendations/rec_8f2/approve</div>
          <div className="text-hot mt-3 font-semibold">409 policy_denied</div>
          <div>gate: suppression</div>
          <div className="text-ink-muted">“this person asked not to be contacted on 4 Aug”</div>
        </div>
      </div>
    </Band>
  );
}

function ClosingCta() {
  return (
    <Band className="bg-ink py-16 text-center text-white sm:py-20">
      {/* This band is `bg-ink` in both themes, so the wordmark is safe here. */}
      <BrandWordmark className="mx-auto mb-8 h-16 w-auto sm:h-24" />

      <h2 className="text-[28px] leading-tight font-semibold tracking-[-0.025em] text-balance sm:text-[34px]">
        Find the people already talking about your problem.
      </h2>
      <p className="mx-auto mt-4 max-w-[34em] text-[17px] leading-relaxed text-[#97a1b0]">
        Start with developer and technical buyers — the richest public signal there is.
      </p>
      <Link
        href="/login"
        className="bg-accent mt-7 inline-flex items-center justify-center rounded-xl px-6 py-3.5 text-sm font-medium text-white"
      >
        Get started free
      </Link>
    </Band>
  );
}

function SiteFooter() {
  return (
    <Band className="border-border border-t py-10">
      {/*
       * The lockup, not the bare mark. At 20px inside a muted grey row the
       * mark's thin cyan strokes had nothing to hold contrast against and read
       * as a faded smudge; at 32px beside full-strength text it does not.
       */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <BrandLockup size="sm" />
        <span className="text-ink-muted text-[13px]">
          No LinkedIn automation. Suppression survives deletion.
        </span>
      </div>

      <p className="text-ink-muted mt-5 text-[13px]">© {new Date().getFullYear()} OutreachGraph</p>
    </Band>
  );
}

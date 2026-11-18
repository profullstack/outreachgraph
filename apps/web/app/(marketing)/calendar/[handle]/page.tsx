import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BrandLockup } from '../../../../components/brand';
import { BookingWidget } from '../../../../components/booking-widget';
import { fetchPublicBookingPage } from '../../../../lib/api';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ handle: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle } = await params;
  const page = await fetchPublicBookingPage(handle).catch(() => undefined);
  if (!page) return { title: 'Booking page · OutreachGraph' };
  const who = page.hostName || page.handle;
  return {
    title: `Book a call with ${who} · OutreachGraph`,
    description:
      page.description ||
      `Pick a time for a ${String(page.durationMinutes)}-minute PairUX video call with ${who}.`,
  };
}

/**
 * The public booking page: /calendar/<handle> (and /schedule/<handle>).
 *
 * Anyone may book. The call is a private PairUX room, and the booking lands
 * in the host's OutreachGraph CRM as a deal at the meeting stage.
 */
export default async function CalendarPage({ params }: Params) {
  const { handle } = await params;
  const page = await fetchPublicBookingPage(decodeURIComponent(handle));
  if (!page) notFound();
  const who = page.hostName || page.handle;

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10">
      <header className="mb-6">
        <p className="text-ink-muted text-sm">Book a call with</p>
        <h1 className="text-2xl font-semibold">{who}</h1>
        <p className="mt-1 text-sm">
          {page.title} · {String(page.durationMinutes)} minutes · PairUX video call
        </p>
        {page.description ? (
          <p className="text-ink-muted mt-3 text-sm whitespace-pre-line">{page.description}</p>
        ) : null}
      </header>
      <BookingWidget
        handle={page.handle}
        hostName={who}
        title={page.title}
        durationMinutes={page.durationMinutes}
        pageTimezone={page.timezone}
        maxDaysAhead={page.maxDaysAhead}
      />
      <p className="text-ink-muted mt-8 flex flex-wrap items-center gap-2 text-xs">
        <span>Scheduling by</span>
        <Link href="/" aria-label="OutreachGraph">
          <BrandLockup size="sm" />
        </Link>
        <span>· calls on</span>
        <a href="https://pairux.com" className="underline">
          PairUX
        </a>
      </p>
    </div>
  );
}

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CancelBooking } from '../../../../../../components/booking-widget';
import { fetchPublicBooking } from '../../../../../../lib/api';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Your booking · OutreachGraph',
  robots: { index: false, follow: false },
};

type Props = {
  params: Promise<{ handle: string; id: string }>;
  searchParams: Promise<{ token?: string }>;
};

/**
 * The guest's manage link from the confirmation email: the call link, a
 * calendar file, cancel, and a way back to pick a new time.
 */
export default async function BookingManagePage({ params, searchParams }: Props) {
  const { handle, id } = await params;
  const { token } = await searchParams;
  if (!token) notFound();
  const view = await fetchPublicBooking(id, token);
  if (!view) notFound();
  const { page, booking } = view;
  const confirmed = booking.status === 'confirmed';
  const when = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: page.timezone,
    timeZoneName: 'short',
  }).format(new Date(booking.startsAt));
  const ics = `/api/v1/public/calendar/bookings/${encodeURIComponent(id)}/ics?token=${encodeURIComponent(token)}`;

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-10">
      <p className="text-ink-muted text-sm">
        {page.title} with {page.hostName || page.handle}
      </p>
      <h1 className="mt-1 text-2xl font-semibold">{when}</h1>
      <p className={`mt-2 text-sm ${confirmed ? 'text-good' : 'text-hot'}`}>
        {confirmed ? 'Confirmed' : 'Cancelled'}
      </p>
      {confirmed ? (
        <>
          <div className="mt-6 flex flex-col gap-2 sm:flex-row">
            <a
              href={booking.meetingUrl}
              className="bg-accent rounded-xl px-4 py-2.5 text-center text-sm font-medium text-white"
            >
              Join the PairUX call
            </a>
            <a
              href={ics}
              className="border-border rounded-xl border px-4 py-2.5 text-center text-sm"
            >
              Add to calendar
            </a>
          </div>
          <div className="mt-8">
            <p className="text-ink-muted mb-2 text-sm">
              Need a different time? Cancel this one, then{' '}
              <Link href={`/calendar/${handle}`} className="underline">
                pick another
              </Link>
              .
            </p>
            <CancelBooking id={id} token={token} />
          </div>
        </>
      ) : (
        <p className="mt-6 text-sm">
          <Link href={`/calendar/${handle}`} className="underline">
            Book another time
          </Link>
        </p>
      )}
    </div>
  );
}

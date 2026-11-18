import { permanentRedirect } from 'next/navigation';

/** /schedule/<handle> is the same page as /calendar/<handle>. */
export default async function ScheduleAlias({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  permanentRedirect(`/calendar/${encodeURIComponent(decodeURIComponent(handle))}`);
}

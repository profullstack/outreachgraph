import { redirect } from 'next/navigation';
import { IntrosPanel } from '../../../components/intros-panel';
import { NotAuthenticatedError, fetchMe } from '../../../lib/api';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Intros · OutreachGraph' };

/**
 * Member introductions (PRD §38): your card, one click to switch it on,
 * people worth meeting, and requests. Both sides say yes, or nothing happens.
 */
export default async function IntrosPage() {
  try {
    await fetchMe();
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    throw error;
  }
  return (
    <div className="pt-4">
      <header className="mb-4">
        <h1 className="text-xl font-semibold">Intros</h1>
        <p className="text-ink-muted text-sm">
          Meet the OutreachGraph members worth knowing. Both sides say yes before anyone gets an
          email address.
        </p>
      </header>
      <IntrosPanel />
    </div>
  );
}

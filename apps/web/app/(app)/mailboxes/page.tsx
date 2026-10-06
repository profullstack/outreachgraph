import { redirect } from 'next/navigation';
import { MailboxesPanel } from '../../../components/mailboxes-view';
import {
  ApiUnavailableError,
  NotAuthenticatedError,
  fetchMailboxes,
  type MailboxesView,
} from '../../../lib/api';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Mailboxes · OutreachGraph' };

/**
 * Every address outreach is sent from, with its health, and the button that
 * adds another. Reached from Settings, which it shares a tab with.
 */
export default async function MailboxesPage() {
  let view: MailboxesView | undefined;
  let offline = false;

  try {
    view = await fetchMailboxes();
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    if (error instanceof ApiUnavailableError) offline = true;
    else throw error;
  }

  return (
    <div className="pt-4">
      <header className="mb-3">
        <h1 className="text-xl font-semibold">Mailboxes</h1>
      </header>

      {offline || !view ? (
        <p className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
          Waiting for the API.
        </p>
      ) : (
        <MailboxesPanel initial={view} />
      )}
    </div>
  );
}

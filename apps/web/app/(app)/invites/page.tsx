import { redirect } from 'next/navigation';
import { InvitesPanel } from '../../../components/invites-panel';
import {
  ApiUnavailableError,
  NotAuthenticatedError,
  fetchInvites,
  type InvitesView,
} from '../../../lib/api';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Invites · OutreachGraph' };

/** Three single-use invites per account, plus an open ?ref= link. */
export default async function InvitesPage() {
  let invites: InvitesView | undefined;
  let offline = false;

  try {
    invites = await fetchInvites();
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login?next=/invites');
    if (error instanceof ApiUnavailableError) offline = true;
    else throw error;
  }

  return (
    <div className="pt-4">
      <header className="mb-4">
        <h1 className="text-xl font-semibold">Invites</h1>
        <p className="text-ink-muted text-sm">A few invites, for people you actually want here.</p>
      </header>

      {offline || !invites ? (
        <p className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
          Waiting for the API.
        </p>
      ) : (
        <InvitesPanel initial={invites} />
      )}
    </div>
  );
}

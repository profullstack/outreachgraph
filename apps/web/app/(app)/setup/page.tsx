import { redirect } from 'next/navigation';
import { ProfileSetup } from '../../../components/profile-setup';
import {
  ApiUnavailableError,
  NotAuthenticatedError,
  fetchMe,
  fetchProfile,
} from '../../../lib/api';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Set up · OutreachGraph' };

/**
 * The setup step (PRD §7, §11).
 *
 * Everything downstream is grounded in what this page collects: the composer
 * writes from the offering, the scorer ranks against the ICP. Until it is
 * filled in, the workspace is pointed at a placeholder offering that reads
 * "Describe what you sell here" — which is what every draft would quote.
 */
export default async function SetupPage() {
  let me;
  let profile;
  let offline = false;

  try {
    [me, profile] = await Promise.all([fetchMe(), fetchProfile()]);
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    if (error instanceof ApiUnavailableError) offline = true;
    else throw error;
  }

  const verified = me?.emailVerified ?? false;

  return (
    <div className="pt-4">
      <header className="mb-5">
        <h1 className="text-xl font-semibold">Set up your profile</h1>
        <p className="text-ink-muted mt-1 text-sm">
          {profile?.configured
            ? `Currently set to “${profile.offering?.name}”. Reading your site again replaces it.`
            : 'Outreach is only as good as what we know about you. This takes a minute.'}
        </p>
      </header>

      {offline ? (
        <p className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
          Waiting for the API.
        </p>
      ) : !verified ? (
        // Reading a site costs a model call, and an unverified signup is an
        // unattributed one. The gate is enforced by the API; this explains it
        // rather than letting the button fail with a 403.
        <p className="border-border bg-surface-raised rounded-2xl border p-4 text-sm">
          Confirm your email address first — we check it before running anything that costs money.
          The link is in your inbox.
        </p>
      ) : (
        <ProfileSetup {...(profile?.url ? { initialUrl: profile.url } : {})} />
      )}
    </div>
  );
}

import Link from 'next/link';
import { BrandLockup } from '../../../components/brand';
import { JoinInvitation } from '../../../components/join-invitation';
import { LoginForm } from '../../../components/login-form';
import {
  ApiUnavailableError,
  NotAuthenticatedError,
  fetchInvitationPreview,
  fetchMe,
  type CurrentUser,
} from '../../../lib/api';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Join a team · OutreachGraph' };

/**
 * Where an invitation link lands.
 *
 * In the marketing group rather than the app group because the recipient
 * usually has no account yet — the app chrome assumes a session, and a bottom
 * nav full of destinations that 401 is a worse first impression than a page
 * that simply explains itself.
 *
 * Three states, and the middle one is the one that makes the flow work: signed
 * in and able to accept; signed out, in which case the sign-in form is here
 * rather than a link away, and returns to this page afterwards; and a link
 * that is no longer good.
 */
export default async function JoinPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  let me: CurrentUser | undefined;
  let invitation;
  let offline = false;

  if (token) {
    try {
      invitation = await fetchInvitationPreview(token);
    } catch (error) {
      if (error instanceof ApiUnavailableError) offline = true;
      else throw error;
    }
  }

  try {
    me = await fetchMe();
  } catch (error) {
    // Not being signed in is the expected case here, not a failure.
    if (!(error instanceof NotAuthenticatedError) && !(error instanceof ApiUnavailableError)) {
      throw error;
    }
  }

  const back = `/join?token=${encodeURIComponent(token ?? '')}`;

  return (
    <div className="flex min-h-[80dvh] items-center justify-center px-5 py-12">
      <div className="border-border w-full max-w-sm sm:rounded-2xl sm:border sm:p-8">
        <header className="mb-6">
          <h1>
            <BrandLockup size="lg" />
          </h1>
        </header>

        {offline ? (
          <p className="text-ink-muted text-sm">
            We cannot reach the server just now. Try the link again in a minute.
          </p>
        ) : !invitation ? (
          <>
            <p className="text-sm">This invitation link is no longer good.</p>
            <p className="text-ink-muted mt-2 text-sm">
              It may have been used, withdrawn, or simply expired — they last two weeks. Ask whoever
              invited you to send another.
            </p>
            <p className="text-ink-muted mt-6 text-xs">
              <Link href="/login" className="underline">
                Sign in instead
              </Link>
            </p>
          </>
        ) : me ? (
          <>
            <p className="text-sm">
              You have been invited to join{' '}
              <span className="font-medium">{invitation.organizationName}</span> as{' '}
              {invitation.role}.
            </p>
            <p className="text-ink-muted mt-2 mb-5 text-sm">
              Signed in as {me.user.email}. Joining adds this account to their team — it does not
              affect your own workspace.
            </p>

            <JoinInvitation token={token ?? ''} organization={invitation.organizationName} />
          </>
        ) : (
          <>
            <p className="text-sm">
              You have been invited to join{' '}
              <span className="font-medium">{invitation.organizationName}</span> as{' '}
              {invitation.role}.
            </p>
            <p className="text-ink-muted mt-2 mb-5 text-sm">
              Sign in to accept, or create an account with{' '}
              <span className="font-medium">{invitation.email}</span> — either brings you straight
              back here.
            </p>

            <LoginForm next={back} />
          </>
        )}
      </div>
    </div>
  );
}

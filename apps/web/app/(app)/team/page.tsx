import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PageGuide } from '../../../components/page-guide';
import { TeamManager } from '../../../components/team-manager';
import {
  ApiUnavailableError,
  NotAuthenticatedError,
  fetchMe,
  fetchTeam,
  type CurrentUser,
  type TeamView,
} from '../../../lib/api';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Team · OutreachGraph' };

/**
 * Who else can get at this account.
 *
 * An organization was a party of one for the whole life of the product — the
 * membership table was written at registration and never again — so this page
 * had nothing to show and did not exist. Everything it manages is scoped to
 * the organization rather than the workspace, because billing already is, and
 * a seat that grants one workspace but not its siblings would have to be
 * enforced in every route that scopes by workspace.
 */
export default async function TeamPage() {
  let me: CurrentUser | undefined;
  let team: TeamView | undefined;
  let offline = false;

  try {
    [me, team] = await Promise.all([fetchMe(), fetchTeam()]);
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    if (error instanceof ApiUnavailableError) offline = true;
    else throw error;
  }

  return (
    <div className="pt-4">
      <header className="mb-4">
        <h1 className="text-xl font-semibold">Team</h1>
        <p className="text-ink-muted text-sm">
          Everyone who can see this account, and anyone still expected.
        </p>
      </header>

      <PageGuide page="team" />

      {offline || !team ? (
        <p className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
          Waiting for the API.
        </p>
      ) : (
        <TeamManager
          members={team.members}
          invitations={team.invitations}
          canManage={team.canManage}
          currentUserId={me?.user.id}
        />
      )}

      <p className="text-ink-muted mt-6 text-center text-xs">
        <Link href="/more" className="underline">
          Back to More
        </Link>
      </p>
    </div>
  );
}

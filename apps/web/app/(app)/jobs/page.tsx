import { redirect } from 'next/navigation';
import { JobPostsBoard } from '../../../components/job-posts-board';
import {
  ApiUnavailableError,
  NotAuthenticatedError,
  fetchCampaigns,
  fetchJobPosts,
  type CampaignRow,
  type JobPostsView,
} from '../../../lib/api';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Job posts · OutreachGraph' };

/**
 * Job postings, and the real people behind each one.
 *
 * Search the job boards by keyword or paste posting URLs; each posting is read
 * from its board and the company's founders, engineering leaders and
 * recruiters are searched for. Every person shows the search result that
 * names them at the company, so they can be checked before anyone writes.
 */
export default async function JobsPage() {
  let view: JobPostsView | undefined;
  let campaigns: CampaignRow[] = [];

  try {
    [view, campaigns] = await Promise.all([fetchJobPosts(), fetchCampaigns()]);
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    if (!(error instanceof ApiUnavailableError)) throw error;
  }

  return (
    <div className="pt-4">
      <header className="mb-4">
        <h1 className="text-xl font-semibold">Job posts</h1>
        <p className="text-ink-muted text-sm">
          A company hiring engineers needs engineering done. Find the person behind the posting.
        </p>
      </header>

      {view ? (
        <JobPostsBoard
          initial={view}
          campaigns={campaigns
            .filter((campaign) => campaign.status !== 'archived')
            .map((campaign) => ({ id: campaign.id, name: campaign.name }))}
        />
      ) : (
        <p className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
          Waiting for the API.
        </p>
      )}
    </div>
  );
}

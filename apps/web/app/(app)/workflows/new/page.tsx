import Link from 'next/link';
import { redirect } from 'next/navigation';
import { WorkflowComposer } from '../../../../components/workflow-composer';
import {
  ApiUnavailableError,
  NotAuthenticatedError,
  fetchWorkflowTemplates,
  type WorkflowTemplateView,
} from '../../../../lib/api';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'New workflow · OutreachGraph' };

export default async function NewWorkflowPage() {
  let templates: WorkflowTemplateView[] = [];
  let offline = false;

  try {
    templates = await fetchWorkflowTemplates();
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    if (error instanceof ApiUnavailableError) offline = true;
    else throw error;
  }

  return (
    <div className="pt-4">
      <nav className="text-ink-muted mb-2 text-xs">
        <Link href="/workflows" className="underline">
          Workflows
        </Link>{' '}
        / New
      </nav>
      <header className="mb-4">
        <h1 className="text-xl font-semibold">New workflow</h1>
        <p className="text-ink-muted text-sm">
          Say who to find, who to write to, how many a day and when. You will see the exact plan
          before anything is saved, and nothing runs until you publish it.
        </p>
      </header>

      {offline ? (
        <p className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
          Waiting for the API.
        </p>
      ) : (
        <WorkflowComposer templates={templates} />
      )}
    </div>
  );
}

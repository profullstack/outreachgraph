import { ApprovalCard } from '../../components/approval-card';
import { ApiAuthError, ApiUnavailableError, fetchApprovals } from '../../lib/api';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Approvals · OutreachGraph' };

export default async function ApprovalsPage() {
  let cards;

  try {
    cards = await fetchApprovals();
  } catch (error) {
    // A missing API in local development should show what to do, not a stack
    // trace — the PWA is often run before the API is up.
    if (error instanceof ApiUnavailableError) return <ApiDown />;
    if (error instanceof ApiAuthError) return <NotAuthorized />;
    throw error;
  }

  return (
    <div className="pt-4">
      <header className="mb-4">
        <h1 className="text-xl font-semibold">Approvals</h1>
        <p className="text-ink-muted text-sm">
          {cards.length === 0
            ? 'Nothing waiting.'
            : `${cards.length} waiting · highest opportunity first`}
        </p>
      </header>

      {cards.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="flex flex-col gap-3">
          {cards.map((card) => (
            <ApprovalCard key={card.id} card={card} />
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
      <p>The queue is clear.</p>
      <p className="mt-1">New recommendations appear as fresh signals arrive.</p>
    </div>
  );
}

function NotAuthorized() {
  return (
    <div className="border-border text-ink-muted mt-4 rounded-2xl border border-dashed p-8 text-center text-sm">
      <p className="text-ink font-medium">The API rejected these credentials.</p>
      <p className="mt-2">
        Check <code className="text-ink">API_TOKEN</code>,{' '}
        <code className="text-ink">WORKSPACE_ID</code> and{' '}
        <code className="text-ink">ORGANIZATION_ID</code> on the web service.
      </p>
    </div>
  );
}

function ApiDown() {
  return (
    <div className="border-border text-ink-muted mt-4 rounded-2xl border border-dashed p-8 text-center text-sm">
      <p className="text-ink font-medium">The API is not reachable.</p>
      <p className="mt-2">
        Start it with{' '}
        <code className="text-ink">bun run --filter &apos;@outreachgraph/api&apos; dev</code>
      </p>
    </div>
  );
}

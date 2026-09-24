import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Avatar } from '../../../components/avatar';
import { ReplyLabelChip } from '../../../components/reply-label-chip';
import {
  ApiUnavailableError,
  NotAuthenticatedError,
  fetchInbox,
  relativeTime,
  type InboxConversationView,
  type InboxFilter,
} from '../../../lib/api';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Inbox · OutreachGraph' };

const FILTERS: readonly { value: InboxFilter; label: string }[] = [
  { value: 'need_reply', label: 'Needs reply' },
  { value: 'replied', label: 'Replied' },
  { value: 'all', label: 'All' },
];

function isFilter(value: string | undefined): value is InboxFilter {
  return value === 'need_reply' || value === 'replied' || value === 'sent' || value === 'all';
}

/**
 * Every conversation in the workspace, newest first.
 *
 * Opens on "Needs reply" because that is the question someone opens an inbox
 * to answer. An out-of-office never lands there: it is a machine talking, and
 * the thread shows it without pretending anyone is waiting on us.
 */
export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; label?: string }>;
}) {
  const { filter: requested, label } = await searchParams;
  const filter: InboxFilter = isFilter(requested) ? requested : 'need_reply';

  let conversations: InboxConversationView[];

  try {
    ({ conversations } = await fetchInbox(filter, label));
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    if (error instanceof ApiUnavailableError) {
      return (
        <p className="text-ink-muted pt-8 text-center text-sm">
          The API is not reachable right now.
        </p>
      );
    }
    throw error;
  }

  return (
    <div className="pt-4">
      <header className="mb-3">
        <h1 className="text-xl font-semibold">Inbox</h1>
        <p className="text-ink-muted text-sm">
          Replies are labelled as they arrive, and the ones worth answering come with a drafted
          reply.
        </p>
      </header>

      <nav aria-label="Filter" className="mb-4 flex gap-2">
        {FILTERS.map((option) => (
          <Link
            key={option.value}
            href={`/inbox?filter=${option.value}`}
            aria-current={option.value === filter ? 'page' : undefined}
            className={`rounded-full border px-3 py-1 text-sm ${
              option.value === filter
                ? 'border-accent text-accent font-medium'
                : 'border-border text-ink-muted'
            }`}
          >
            {option.label}
          </Link>
        ))}
      </nav>

      {label ? (
        <p className="text-ink-muted mb-3 text-xs">
          Showing replies labelled <span className="text-ink font-medium">{label}</span>.{' '}
          <Link href={`/inbox?filter=${filter}`} className="underline">
            Clear
          </Link>
        </p>
      ) : null}

      {conversations.length === 0 ? (
        <div className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
          {filter === 'need_reply'
            ? 'Nobody is waiting on you. Replies land here as the mailbox is read.'
            : 'No conversations yet.'}
        </div>
      ) : (
        <ul className="border-border divide-border divide-y overflow-hidden rounded-2xl border">
          {conversations.map((conv) => (
            <li key={conv.person_id}>
              <Link
                href={`/inbox/${encodeURIComponent(conv.person_id)}`}
                className="bg-surface-raised flex gap-3 p-4"
              >
                <Avatar name={conv.name} src={conv.avatar_url} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{conv.name}</span>
                    <span className="text-ink-muted shrink-0 text-xs">
                      {relativeTime(conv.last_message_at)}
                    </span>
                  </div>
                  <p className="text-ink-muted truncate text-xs">
                    {[conv.title, conv.company].filter(Boolean).join(' · ') ||
                      conv.networks.join(', ')}
                  </p>
                  <p className="mt-1 line-clamp-2 text-sm">
                    <span className="text-ink-muted">
                      {conv.last_message_from === 'us'
                        ? 'You: '
                        : conv.last_message_from === 'automated'
                          ? 'Auto: '
                          : ''}
                    </span>
                    {conv.last_message_preview ?? ''}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {conv.label ? (
                      <ReplyLabelChip label={conv.label.label} confidence={conv.label.confidence} />
                    ) : null}
                    {conv.pending_reply_id ? (
                      <span className="text-accent text-[11px] font-medium">Draft ready</span>
                    ) : null}
                    {conv.suppressed ? (
                      <span className="text-hot text-[11px] font-medium">Do not contact</span>
                    ) : null}
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

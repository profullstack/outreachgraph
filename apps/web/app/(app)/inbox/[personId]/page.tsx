import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Avatar } from '../../../../components/avatar';
import { InboxReply } from '../../../../components/inbox-reply';
import { ReplyLabelChip } from '../../../../components/reply-label-chip';
import {
  ApiUnavailableError,
  NotAuthenticatedError,
  fetchThread,
  relativeTime,
  type InboxThreadView,
} from '../../../../lib/api';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Conversation · OutreachGraph' };

/**
 * One conversation: what we sent, what they said, and the answer waiting.
 *
 * The original outbound is marked because "what did they say yes to?" is the
 * first thing anyone asks of a reply. Automated messages — an absence notice,
 * a bounce — are shown muted and in the middle, where they happened, so the
 * reader knows why nobody answered without mistaking a robot for a person.
 */
export default async function ThreadPage({ params }: { params: Promise<{ personId: string }> }) {
  const { personId } = await params;

  let thread: InboxThreadView;
  try {
    thread = await fetchThread(personId);
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    if (error instanceof ApiUnavailableError) {
      return (
        <p className="text-ink-muted pt-8 text-center text-sm">
          The API is not reachable right now.
        </p>
      );
    }
    notFound();
  }

  const { person, messages, pending_reply: pending } = thread;
  const lastInbound = [...messages].reverse().find((m) => m.from === 'them');
  const canEmail =
    !thread.suppressed &&
    (lastInbound ? lastInbound.network === 'email' : messages.some((m) => m.network === 'email'));
  // A card that only asks a human to look (a possible stop request) has no
  // words to send; its reason is shown instead of a draft.
  const draft = pending?.action === 'send_email' ? pending.body : null;

  return (
    <div className="pt-4">
      <Link href="/inbox" className="text-accent text-sm underline">
        Back to the inbox
      </Link>

      <header className="mt-3 mb-4 flex items-center gap-3">
        <Avatar name={person.name} src={person.avatar_url} />
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold">
            <Link href={`/prospects/${encodeURIComponent(person.id)}`}>{person.name}</Link>
          </h1>
          <p className="text-ink-muted truncate text-sm">
            {[person.title, person.company].filter(Boolean).join(' · ')}
          </p>
        </div>
      </header>

      {thread.suppressed ? (
        <p className="border-hot/40 bg-hot/5 text-hot mb-4 rounded-xl border p-3 text-sm">
          This person is on a do-not-contact list. Nothing more will be sent.
        </p>
      ) : null}

      <ol className="mb-4 space-y-3">
        {messages.map((message) => {
          const ours = message.from === 'us';
          const robot = message.from === 'automated';
          return (
            <li key={message.id} className={`flex ${ours ? 'justify-end' : 'justify-start'}`}>
              <article
                className={`max-w-[85%] rounded-2xl border p-3 text-sm ${
                  ours
                    ? 'border-accent/30 bg-accent/5'
                    : robot
                      ? 'border-border text-ink-muted border-dashed'
                      : 'border-border bg-surface-raised'
                }`}
              >
                <div className="text-ink-muted mb-1 flex flex-wrap items-center gap-2 text-[11px]">
                  <span className="font-medium">
                    {ours ? 'You' : robot ? 'Automatic' : person.name}
                  </span>
                  <span>{message.network}</span>
                  <span>{relativeTime(message.at)}</span>
                  {message.original ? <span className="text-accent">Original message</span> : null}
                  {message.label ? (
                    <ReplyLabelChip
                      label={message.label.label}
                      confidence={message.label.confidence}
                      source={message.label.source ?? null}
                      reason={message.label.reason ?? null}
                    />
                  ) : null}
                </div>
                {message.subject ? (
                  <p className="text-ink-muted mb-1 text-xs">{message.subject}</p>
                ) : null}
                <p className="whitespace-pre-wrap">{message.body ?? ''}</p>
              </article>
            </li>
          );
        })}
      </ol>

      {pending && pending.action !== 'send_email' ? (
        <p className="border-border bg-surface-raised mb-3 rounded-xl border p-3 text-sm">
          {pending.reason}{' '}
          <Link href="/approvals" className="text-accent underline">
            Review it in Approvals
          </Link>
        </p>
      ) : null}

      <InboxReply
        key={pending?.recommendation_id ?? 'none'}
        personId={person.id}
        draft={draft}
        recommendationId={draft ? pending?.recommendation_id : null}
        canEmail={canEmail}
      />
    </div>
  );
}

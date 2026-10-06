import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Avatar } from '../../../../components/avatar';
import { AddLeads } from '../../../../components/add-leads';
import { CampaignControls } from '../../../../components/campaign-controls';
import { ScreenedLeads } from '../../../../components/screened-leads';
import {
  ApiUnavailableError,
  NotAuthenticatedError,
  fetchInbox,
  fetchProductOverview,
  relativeTime,
  type InboxConversationView,
  type ProductOverviewView,
} from '../../../../lib/api';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Product · OutreachGraph' };

/**
 * One product, read top to bottom in the order the work happens.
 *
 * What it sells, who buys it, who we found, what we wrote, what came back —
 * the shape AutoGTM-style tools give a project page, because it answers the
 * only question someone opens a product for: is this one working, and if not,
 * which step is it stuck on. The switches sit at the top, beside the numbers
 * they change.
 */
export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let overview: ProductOverviewView;
  let replies: InboxConversationView[] = [];

  try {
    [overview, { conversations: replies }] = await Promise.all([
      fetchProductOverview(id),
      fetchInbox('all', undefined, id).catch((error: unknown) => {
        if (error instanceof NotAuthenticatedError) throw error;
        return { conversations: [] as InboxConversationView[] };
      }),
    ]);
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    if (error instanceof Error && error.message.startsWith('API 404')) notFound();
    if (error instanceof ApiUnavailableError) {
      return <p className="text-ink-muted pt-8 text-center text-sm">The API is not reachable.</p>;
    }
    throw error;
  }

  const { product, profile, campaign, leads, messages } = overview;
  const offering = profile.offering;
  const icp = profile.icp;
  const host = product.url?.replace(/^https?:\/\//, '').replace(/\/$/, '');

  return (
    <div className="pt-4">
      <Link href="/products" className="text-ink-muted text-sm">
        ← Products
      </Link>

      <header className="mt-2 mb-4">
        <h1 className="text-xl font-semibold">{product.name}</h1>
        {host ? (
          <a href={product.url ?? '#'} className="text-ink-muted text-sm" target="_blank">
            {host}
          </a>
        ) : null}
        <div className="mt-3">
          {campaign ? (
            <CampaignControls
              campaignId={campaign.id}
              autopilot={campaign.approval_mode === 'trusted_automation'}
              status={campaign.status}
            />
          ) : (
            <p className="text-ink-muted text-sm">No campaign yet.</p>
          )}
        </div>
      </header>

      {campaign ? (
        <section className="mb-6 grid grid-cols-4 gap-2">
          <Stat label="Leads" value={campaign.people} />
          <Stat label="Contacted" value={campaign.contacted} />
          <Stat label="Replies" value={campaign.replied} />
          <Stat label="Waiting" value={campaign.awaiting_approval} />
        </section>
      ) : null}

      {campaign && campaign.jobs_pending > 0 ? (
        <p className="text-ink-muted -mt-4 mb-6 text-xs">
          Working: {campaign.jobs_pending} {campaign.jobs_pending === 1 ? 'task' : 'tasks'} queued.
        </p>
      ) : null}

      <Step n={1} title="What it sells" action={{ href: `/setup?product=${id}`, label: 'Edit' }}>
        {offering ? (
          <>
            <p className="text-sm">{offering.description || offering.category}</p>
            {offering.valuePropositions.length > 0 ? (
              <ul className="text-ink-muted mt-2 list-disc pl-5 text-sm">
                {offering.valuePropositions.slice(0, 3).map((v) => (
                  <li key={v}>{v}</li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <Empty>Not described yet.</Empty>
        )}
      </Step>

      <Step n={2} title="Who buys it" action={{ href: `/setup?product=${id}`, label: 'Edit' }}>
        {campaign?.seed_value ? (
          <p className="text-sm">
            <span className="text-ink-muted">Searching for </span>
            {campaign.seed_value}
          </p>
        ) : null}
        {icp ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {[...icp.titles, ...icp.industries].slice(0, 10).map((term) => (
              <span
                key={term}
                className="border-border text-ink-muted rounded-full border px-2 py-0.5 text-xs"
              >
                {term}
              </span>
            ))}
          </div>
        ) : null}
        {campaign?.brief ? <p className="text-ink-muted mt-2 text-xs">{campaign.brief}</p> : null}
        {!campaign?.seed_value && !icp ? <Empty>No buyer profile yet.</Empty> : null}
      </Step>

      <Step n={3} title={`Leads${campaign ? ` · ${campaign.people}` : ''}`}>
        {campaign ? (
          <>
            <AddLeads campaignId={campaign.id} />
            <ScreenedLeads campaignId={campaign.id} />
          </>
        ) : null}
        {leads.length === 0 ? (
          <Empty>
            {campaign && campaign.jobs_pending > 0
              ? 'Still reading sites. People appear here as they are found.'
              : 'Nobody found yet.'}
          </Empty>
        ) : (
          <ul className="border-border divide-border divide-y overflow-hidden rounded-xl border">
            {leads.slice(0, 20).map((lead) => (
              <li key={lead.person_id}>
                <Link
                  href={`/prospects/${encodeURIComponent(lead.person_id)}`}
                  className="bg-surface-raised flex items-center gap-3 px-3 py-2"
                >
                  <Avatar name={lead.name} src={lead.avatar_url} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{lead.name}</div>
                    <div className="text-ink-muted truncate text-xs">
                      {[lead.title, lead.company].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-sm font-semibold tabular-nums">{lead.match ?? '—'}</div>
                    <div className="text-ink-muted text-[11px]">{stageLabel(lead)}</div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {leads.length > 20 ? (
          <p className="text-ink-muted mt-2 text-xs">
            Showing the 20 best matches of {campaign?.people ?? leads.length}.
          </p>
        ) : null}
      </Step>

      <Step n={4} title="Messages" action={{ href: '/approvals', label: 'Approve' }}>
        {messages.length === 0 ? (
          <Empty>Nothing written yet. A draft is written when a lead is worth writing to.</Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {messages.map((message) => (
              <li
                key={message.id}
                className="border-border bg-surface-raised rounded-xl border p-3 text-sm"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-medium">
                    To {message.name}
                    {message.company ? ` · ${message.company}` : ''}
                  </span>
                  <span className="text-ink-muted shrink-0 text-[11px]">
                    {messageStatus(message.status)} · {relativeTime(message.created_at)}
                  </span>
                </div>
                {message.subject ? <p className="mt-1 font-medium">{message.subject}</p> : null}
                <p className="text-ink-muted mt-1 line-clamp-3 whitespace-pre-line">
                  {message.body}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Step>

      <Step
        n={5}
        title="Replies"
        action={{ href: `/inbox?filter=all&product=${encodeURIComponent(id)}`, label: 'Inbox' }}
      >
        {replies.length === 0 ? (
          <Empty>No conversations yet.</Empty>
        ) : (
          <ul className="border-border divide-border divide-y overflow-hidden rounded-xl border">
            {replies.slice(0, 5).map((conv) => (
              <li key={conv.person_id}>
                <Link
                  href={`/inbox/${encodeURIComponent(conv.person_id)}`}
                  className="bg-surface-raised block px-3 py-2"
                >
                  <div className="flex justify-between gap-2 text-sm">
                    <span className="truncate font-medium">{conv.name}</span>
                    <span className="text-ink-muted shrink-0 text-xs">
                      {relativeTime(conv.last_message_at)}
                    </span>
                  </div>
                  <p className="text-ink-muted line-clamp-1 text-xs">
                    {conv.status === 'need_reply' ? 'Waiting on you · ' : ''}
                    {conv.last_message_preview ?? ''}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Step>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="border-border bg-surface-raised rounded-xl border p-2.5 text-center">
      <p className="text-lg font-semibold tabular-nums">{value.toLocaleString()}</p>
      <p className="text-ink-muted text-[11px]">{label}</p>
    </div>
  );
}

function Step({
  n,
  title,
  action,
  children,
}: {
  n: number;
  title: string;
  action?: { href: string; label: string };
  children: React.ReactNode;
}) {
  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center gap-2">
        <span className="bg-accent flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white">
          {n}
        </span>
        <h2 className="flex-1 text-sm font-semibold">{title}</h2>
        {action ? (
          <Link href={action.href} className="text-accent text-xs font-medium">
            {action.label}
          </Link>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="border-border text-ink-muted rounded-xl border border-dashed p-4 text-center text-sm">
      {children}
    </p>
  );
}

function stageLabel(lead: { stage: string; contact: string }): string {
  if (lead.contact === 'replied' || lead.contact === 'responded') return 'replied';
  if (lead.contact === 'contacted') return 'contacted';
  return lead.stage.replace(/_/g, ' ');
}

function messageStatus(status: string): string {
  if (status === 'pending') return 'waiting for you';
  if (status === 'approved' || status === 'executed' || status === 'sent') return 'sent';
  return status.replace(/_/g, ' ');
}

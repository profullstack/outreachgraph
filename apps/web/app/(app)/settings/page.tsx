import Link from 'next/link';
import { redirect } from 'next/navigation';
import { SignOutButton } from '../../../components/sign-out-button';
import { WorkspaceSwitcher } from '../../../components/workspace-switcher';
import { SettingsForm } from '../../../components/settings-form';
import { BlueskyForm } from '../../../components/bluesky-form';
import { ApiKeysForm } from '../../../components/api-keys-form';
import { SendersPanel } from '../../../components/senders-panel';
import { WebhooksForm } from '../../../components/webhooks-form';
import { CrmForm } from '../../../components/crm-form';
import { PageGuide } from '../../../components/page-guide';
import {
  ApiUnavailableError,
  NotAuthenticatedError,
  fetchApiKeys,
  fetchMe,
  fetchBlueskyIntegration,
  fetchCrmIntegration,
  fetchSenders,
  fetchSettings,
  fetchWebhooks,
  type ApiKeyView,
  type BlueskyIntegrationView,
  type SenderView,
  type CrmIntegrationView,
  type SettingsView,
  type WebhooksView,
} from '../../../lib/api';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Settings · OutreachGraph' };

/**
 * Every page that does not need a tab, reached from one list.
 *
 * The app had eighteen destinations: six tabs and a "More" page of twelve
 * links. Five tabs now carry the daily work, and this page holds the rest —
 * the account, the controls, and the tools someone opens once a week. It is
 * grouped so the long tail stays out of the way: sending first, because
 * nothing leaves without it, and the developer settings folded shut.
 */
const TOOLS = [
  { href: '/team', label: 'Team', hint: 'Invite colleagues and see who has access' },
  { href: '/billing', label: 'Billing', hint: 'Your plan, what is left this month, credits' },
  { href: '/import', label: 'Import contacts', hint: 'A CSV of people who already know you' },
  { href: '/cadences', label: 'Follow-ups', hint: 'A sequence of touches over days' },
  { href: '/rules', label: 'Rules', hint: 'When this happens, do that' },
  { href: '/research', label: 'Research tables', hint: 'Ask the same questions of a list' },
  { href: '/prospects', label: 'All people', hint: 'Everyone found, across every product' },
  { href: '/signals', label: 'Signals', hint: 'The public activity behind each match' },
  {
    href: '/outreach',
    label: 'Start a one-off campaign',
    hint: 'From a market or a list of companies',
  },
  { href: '/today', label: 'Activity', hint: 'What the worker is doing right now' },
] as const;

/**
 * Notification and autopilot settings.
 *
 * Its own page rather than a section of More, because once the product runs
 * unattended these are the controls that decide what it does while nobody is
 * looking — and "how much may it send today" is not a preference to hide
 * behind a disclosure triangle.
 */
export default async function SettingsPage() {
  let settings: SettingsView | undefined;
  let bluesky: BlueskyIntegrationView | undefined;
  let apiKeys: readonly ApiKeyView[] = [];
  let senders: readonly SenderView[] = [];
  let webhooks: WebhooksView | undefined;
  let crm: CrmIntegrationView | undefined;
  let me: Awaited<ReturnType<typeof fetchMe>> | undefined;
  let offline = false;

  try {
    // Webhooks and CRM are approver-only, and a viewer's 403 must hide the
    // two sections rather than bounce the whole page to the login screen.
    [settings, bluesky, apiKeys, senders, webhooks, crm, me] = await Promise.all([
      fetchSettings(),
      fetchBlueskyIntegration(),
      fetchApiKeys(),
      fetchSenders(),
      fetchWebhooks().catch(() => undefined),
      fetchCrmIntegration().catch(() => undefined),
      fetchMe(),
    ]);
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    if (error instanceof ApiUnavailableError) offline = true;
    else throw error;
  }

  return (
    <div className="pt-4">
      <header className="mb-4">
        <h1 className="text-xl font-semibold">Settings</h1>
        {me ? (
          <p className="text-ink-muted text-sm">
            {me.user.email} · {me.role}
          </p>
        ) : null}
      </header>

      <PageGuide page="settings" />

      {me ? (
        <WorkspaceSwitcher
          workspaces={me.workspaces ?? []}
          currentId={me.workspaceId}
          canCreate={me.role === 'owner' || me.role === 'admin'}
        />
      ) : null}

      {offline || !settings ? (
        <p className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
          Waiting for the API.
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          <Section title="Sending">
            {/* First: nothing leaves without a mailbox to leave through. */}
            <MailboxesLink senders={senders} />
            <Link
              href="/planner"
              className="border-border bg-surface-raised flex items-center justify-between gap-3 rounded-2xl border p-4"
            >
              <span className="min-w-0">
                <span className="block text-sm font-semibold">Outreach planner</span>
                <span className="text-ink-muted block text-xs">
                  Twelve months of plays, launched for every product automatically.
                </span>
              </span>
              <span className="text-accent shrink-0 text-sm font-medium">Open ›</span>
            </Link>
            <SendersPanel initial={senders.filter((sender) => sender.network !== 'email')} />
            {bluesky ? <BlueskyForm initial={bluesky} /> : null}
          </Section>

          <Section title="Alerts and limits">
            <SettingsForm initial={settings} />
          </Section>

          <Section title="Tools">
            <ul className="border-border divide-border divide-y overflow-hidden rounded-2xl border">
              {TOOLS.map((tool) => (
                <li key={tool.href}>
                  <Link
                    href={tool.href}
                    className="bg-surface-raised flex items-baseline justify-between gap-3 px-4 py-3"
                  >
                    <span className="text-sm font-medium">{tool.label}</span>
                    <span className="text-ink-muted truncate text-xs">{tool.hint}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Section>

          {/* Folded: webhooks, CRM sync and API keys are for the agents and
              integrations that drive the product, not for daily use. */}
          <details className="border-border bg-surface-raised rounded-2xl border p-4">
            <summary className="cursor-pointer text-sm font-medium">
              Developer: webhooks, CRM sync, API keys
            </summary>
            <div className="mt-4 flex flex-col gap-4">
              {webhooks ? <WebhooksForm initial={webhooks} /> : null}
              {crm ? <CrmForm initial={crm} /> : null}
              <ApiKeysForm initial={apiKeys} />
            </div>
          </details>

          <SignOutButton />
        </div>
      )}
    </div>
  );
}

/** The way to the Mailboxes page, with enough on it to know whether to go. */
function MailboxesLink({ senders }: { senders: readonly SenderView[] }) {
  const mailboxes = senders.filter((sender) => sender.network === 'email');
  const active = mailboxes.filter((sender) => sender.status === 'active').length;
  const sent = mailboxes.reduce((sum, sender) => sum + sender.sentToday, 0);
  const cap = mailboxes.reduce((sum, sender) => sum + sender.effectiveCapToday, 0);

  return (
    <Link
      href="/mailboxes"
      className="border-border bg-surface-raised flex items-center justify-between gap-3 rounded-2xl border p-4"
    >
      <span className="min-w-0">
        <span className="block text-sm font-semibold">Mailboxes</span>
        <span className="text-ink-muted block text-xs">
          {mailboxes.length === 0
            ? 'None connected yet. Add the address your outreach sends from.'
            : `${active} of ${mailboxes.length} active · ${sent}/${cap} sent today`}
        </span>
      </span>
      <span className="text-accent shrink-0 text-sm font-medium">
        {mailboxes.length === 0 ? 'Add mailbox' : 'Manage'} ›
      </span>
    </Link>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-ink-muted text-[11px] font-semibold tracking-wide uppercase">{title}</h2>
      {children}
    </section>
  );
}

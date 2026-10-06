'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { MailboxView, MailboxesView } from '../lib/api';

/**
 * The Mailboxes page: every address outreach is sent from, and the one button
 * that adds another.
 *
 * Modelled on the mailbox screens of the automated cold-email tools (Swokei
 * in particular), because the shape is right for a product that sends on its
 * own: a glance tells you how many addresses there are, how much they may
 * send today, which are still warming up and whether anyone is reading the
 * replies. Each card carries the few controls a human needs when something
 * looks wrong; adding one asks for an address and a password and works the
 * rest out.
 */
export function MailboxesPanel({ initial }: { initial: MailboxesView }) {
  const [adding, setAdding] = useState<{ email?: string } | undefined>();
  const { mailboxes, summary } = initial;

  if (!initial.canConnect) {
    return (
      <p className="border-border text-ink-muted rounded-2xl border border-dashed p-6 text-sm">
        This deployment has no <code className="text-ink">SECRET_ENCRYPTION_KEY</code>, so a mailbox
        password cannot be stored safely yet. Set one and restart to add mailboxes.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-ink-muted text-sm">
          The addresses your campaigns send from. Sending rotates across them, each lead stays on
          the mailbox that first wrote to them, and replies come back to you.
        </p>
        <button
          type="button"
          onClick={() => setAdding({})}
          className="bg-accent min-h-[40px] shrink-0 rounded-xl px-4 text-sm font-medium text-white"
        >
          Add mailbox
        </button>
      </div>

      {mailboxes.length === 0 ? (
        <EmptyState onAdd={() => setAdding({})} platformFallback={initial.platformFallback} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat
              label="Mailboxes"
              value={`${summary.active}/${summary.mailboxes}`}
              hint="active"
            />
            <Stat
              label="Sent today"
              value={`${summary.sentToday}/${summary.capacityToday}`}
              hint="across all"
            />
            <Stat label="Warming up" value={String(summary.warming)} hint="ramping to full" />
            <Stat
              label="Replies read"
              value={`${summary.mailboxes - summary.notReadingReplies}/${summary.mailboxes}`}
              hint={summary.notReadingReplies > 0 ? 'some unread' : 'all inboxes'}
              warn={summary.notReadingReplies > 0}
            />
          </div>

          <ul className="flex flex-col gap-3">
            {mailboxes.map((mailbox) => (
              <MailboxCard
                key={mailbox.id}
                mailbox={mailbox}
                onReconnect={() => setAdding({ email: mailbox.fromEmail ?? undefined })}
              />
            ))}
          </ul>
        </>
      )}

      {adding ? (
        <AddMailboxDialog
          presets={initial.presets}
          initialEmail={adding.email}
          onClose={() => setAdding(undefined)}
        />
      ) : null}
    </div>
  );
}

function EmptyState({ onAdd, platformFallback }: { onAdd: () => void; platformFallback: boolean }) {
  return (
    <section className="border-border bg-surface-raised flex flex-col items-center gap-3 rounded-2xl border p-8 text-center">
      <MailIcon />
      <h2 className="text-base font-semibold">One thing left: a mailbox</h2>
      <p className="text-ink-muted max-w-sm text-sm">
        {platformFallback
          ? 'Until you connect one, outreach goes out through the shared platform sender and replies do not reach you. '
          : 'Before anything can send you need one real mailbox connected. '}
        Turn on warm-up the day you connect it, so it has a reputation by the time a campaign
        starts.
      </p>
      <button
        type="button"
        onClick={onAdd}
        className="bg-accent min-h-[40px] rounded-xl px-5 text-sm font-medium text-white"
      >
        Connect a mailbox
      </button>
    </section>
  );
}

function Stat({
  label,
  value,
  hint,
  warn,
}: {
  label: string;
  value: string;
  hint: string;
  warn?: boolean;
}) {
  return (
    <div className="border-border bg-surface-raised rounded-xl border p-3">
      <p className="text-ink-muted text-[11px] font-semibold tracking-wide uppercase">{label}</p>
      <p className={`mt-1 text-lg font-semibold tabular-nums ${warn ? 'text-hot' : ''}`}>{value}</p>
      <p className="text-ink-muted text-xs">{hint}</p>
    </div>
  );
}

// ------------------------------------------------------------------ one card

function MailboxCard({ mailbox, onReconnect }: { mailbox: MailboxView; onReconnect: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [cap, setCap] = useState(String(mailbox.configuredCap));
  const [showDns, setShowDns] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  async function send(method: 'PATCH' | 'DELETE', body?: Record<string, unknown>): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/v1/senders/${mailbox.id}`, {
        method,
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) {
        setError(await errorText(response));
        return;
      }
      router.refresh();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  const warming = mailbox.warmup.enabled && !mailbox.warmup.complete;
  const sentShare =
    mailbox.effectiveCapToday > 0
      ? Math.min(100, Math.round((mailbox.sentToday / mailbox.effectiveCapToday) * 100))
      : 0;
  const warmShare =
    warming && mailbox.warmup.rampCapToday !== null && mailbox.configuredCap > 0
      ? Math.min(100, Math.round((mailbox.warmup.rampCapToday / mailbox.configuredCap) * 100))
      : 100;
  const needsReconnect =
    mailbox.status === 'revoked' || mailbox.status === 'error' || Boolean(mailbox.repliesError);

  return (
    <li className="border-border bg-surface-raised rounded-2xl border p-4">
      <div className="flex items-start gap-3">
        <span className="bg-accent/15 text-accent flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold uppercase">
          {(mailbox.fromEmail ?? mailbox.handle ?? '?').slice(0, 1)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">
            {mailbox.fromEmail ?? mailbox.handle ?? 'Unnamed mailbox'}
          </p>
          <p className="text-ink-muted truncate text-xs">
            {mailbox.providerLabel}
            {mailbox.fromName ? ` · ${mailbox.fromName}` : ''}
            {mailbox.label ? ` · ${mailbox.label}` : ''}
          </p>
        </div>
        <StatusBadge status={mailbox.status} />
        <HealthScore score={mailbox.healthScore} />
      </div>

      {mailbox.status !== 'active' && mailbox.statusReason ? (
        <p className="text-ink-muted mt-3 text-xs">{mailbox.statusReason}</p>
      ) : null}

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Meter
          label="Sent today"
          value={`${mailbox.sentToday}/${mailbox.effectiveCapToday}`}
          share={sentShare}
          tone="bg-accent"
        />
        <Meter
          label={
            !mailbox.warmup.enabled
              ? 'Warm-up off'
              : warming
                ? `Warm-up day ${(mailbox.warmup.day ?? 0) + 1}`
                : 'Warmed up'
          }
          value={
            warming
              ? `${mailbox.warmup.rampCapToday}/${mailbox.configuredCap} a day`
              : `${mailbox.configuredCap} a day`
          }
          share={warmShare}
          tone={warming ? 'bg-amber-500' : 'bg-good'}
        />
        <div>
          <div className="text-ink-muted flex justify-between text-xs">
            <span>Bounce risk</span>
            <span className="tabular-nums">
              {mailbox.bounces30d}/{mailbox.sends30d} in 30d
            </span>
          </div>
          <RiskChip risk={mailbox.bounceRisk} />
        </div>
      </div>

      <RepliesLine mailbox={mailbox} />

      <WarmupNetworkPanel
        mailbox={mailbox}
        busy={busy}
        onToggle={(on) => send('PATCH', { warmupNetwork: on })}
      />

      {mailbox.healthIssues.filter((issue) => issue !== 'Warming up').length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-1">
          {mailbox.healthIssues
            .filter((issue) => issue !== 'Warming up')
            .map((issue) => (
              <li key={issue} className="bg-hot/10 text-hot rounded-full px-2 py-0.5 text-[11px]">
                {issue}
              </li>
            ))}
        </ul>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {needsReconnect ? (
          <button
            type="button"
            onClick={onReconnect}
            className="bg-accent min-h-[36px] rounded-xl px-3 text-xs font-medium text-white"
          >
            Reconnect
          </button>
        ) : null}
        {mailbox.status === 'active' ? (
          <SmallButton disabled={busy} onClick={() => send('PATCH', { paused: true })}>
            Pause
          </SmallButton>
        ) : mailbox.status === 'revoked' ? null : (
          <SmallButton disabled={busy} onClick={() => send('PATCH', { paused: false })}>
            Resume
          </SmallButton>
        )}
        <SmallButton onClick={() => setShowDns((v) => !v)}>
          {showDns ? 'Hide DNS check' : 'Check DNS'}
        </SmallButton>
        <SmallButton onClick={() => setShowSettings((v) => !v)}>
          {showSettings ? 'Close settings' : 'Settings'}
        </SmallButton>
      </div>

      {showSettings ? (
        <div className="border-border mt-3 flex flex-col gap-3 rounded-xl border p-3">
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const value = Number(cap);
              if (!Number.isInteger(value) || value < 0) {
                setError('a daily limit is a whole number');
                return;
              }
              void send('PATCH', { dailyCap: value });
            }}
          >
            <label htmlFor={`cap-${mailbox.id}`} className="text-sm">
              Daily limit
            </label>
            <input
              id={`cap-${mailbox.id}`}
              inputMode="numeric"
              value={cap}
              onChange={(event) => setCap(event.target.value)}
              className="border-border bg-surface w-20 rounded-lg border px-2 py-1 text-sm tabular-nums"
            />
            <SmallButton type="submit" disabled={busy || cap === String(mailbox.configuredCap)}>
              Save
            </SmallButton>
            <span className="text-ink-muted text-xs">
              30–50 a day per mailbox keeps cold email out of spam.
            </span>
          </form>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={mailbox.warmup.enabled}
              disabled={busy}
              onChange={(event) => void send('PATCH', { warmup: event.target.checked })}
            />
            <span>
              Warm-up: start at a handful a day and climb to the limit. Switch off only for an
              address that has been sending for months.
            </span>
          </label>

          <p className="text-ink-muted text-xs">
            Sends via {mailbox.smtpHost ?? 'unknown host'}
            {mailbox.imapHost ? `, reads replies via ${mailbox.imapHost}` : ', replies not read'}.
            To change the password or servers, reconnect with the same address.
          </p>

          <div>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (
                  confirm(
                    `Remove ${mailbox.fromEmail ?? 'this mailbox'}? Its leads move to your other mailboxes.`,
                  )
                ) {
                  void send('DELETE');
                }
              }}
              className="border-border text-hot min-h-[36px] rounded-xl border px-3 text-xs font-medium disabled:opacity-50"
            >
              Remove mailbox
            </button>
          </div>
        </div>
      ) : null}

      {showDns ? <DnsReport mailboxId={mailbox.id} /> : null}

      {error ? (
        <p role="alert" className="text-hot mt-2 text-xs">
          {error}
        </p>
      ) : null}
    </li>
  );
}

/**
 * The warm-up network: on or off, how its mail is landing, and the one word
 * that filters it out of a forwarded inbox such as Gmail.
 */
function WarmupNetworkPanel({
  mailbox,
  busy,
  onToggle,
}: {
  mailbox: MailboxView;
  busy: boolean;
  onToggle: (on: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);
  const warm = mailbox.warmupNetwork;

  if (!warm?.network) {
    return (
      <div className="border-border mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dashed p-3">
        <p className="text-ink-muted min-w-0 flex-1 text-xs">
          <span className="text-ink font-medium">Warm-up network is off.</span> Turn it on and this
          mailbox trades short conversations with other mailboxes: rescued from spam, read and
          answered, so providers learn to trust it. Warm-up mail is filed out of your inbox.
        </p>
        <button
          type="button"
          disabled={busy || mailbox.status !== 'active' || !mailbox.readsReplies}
          onClick={() => onToggle(true)}
          className="bg-accent min-h-[36px] shrink-0 rounded-xl px-3 text-xs font-medium text-white disabled:opacity-50"
        >
          Start warm-up
        </button>
      </div>
    );
  }

  const placement =
    warm.received14d > 0 ? Math.round((warm.inbox14d / warm.received14d) * 100) : null;
  const filter = warm.tag ? `"${warm.tag}"` : '';

  return (
    <div className="border-border mt-3 rounded-xl border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold">Warm-up network · day {(warm.day ?? 0) + 1}</p>
        <button
          type="button"
          disabled={busy}
          onClick={() => onToggle(false)}
          className="text-ink-muted text-xs underline disabled:opacity-50"
        >
          Stop
        </button>
      </div>

      {warm.peers === 0 ? (
        <p className="text-hot mt-2 text-xs">
          No other mailbox is in the network yet, so nothing can be sent. Add a second mailbox (any
          domain) and start its warm-up too.
        </p>
      ) : null}

      {warm.lastError ? (
        <p className="text-hot mt-2 text-xs break-words">
          The last warm-up email from this mailbox failed: {warm.lastError}
        </p>
      ) : null}

      <dl className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <WarmStat label="Sent today" value={`${warm.sentToday}/${warm.targetToday ?? 0}`} />
        <WarmStat
          label="Inbox placement"
          value={placement === null ? '—' : `${placement}%`}
          tone={
            placement === null
              ? ''
              : placement >= 90
                ? 'text-good'
                : placement >= 70
                  ? 'text-amber-600'
                  : 'text-hot'
          }
        />
        <WarmStat label="Saved from spam" value={String(warm.spam14d)} />
        <WarmStat label="Answered" value={String(warm.replied14d)} />
      </dl>

      {warm.tag ? (
        <div className="bg-surface mt-3 rounded-lg p-2 text-xs">
          <p className="text-ink-muted">
            Every warm-up email this mailbox receives ends with{' '}
            <code className="text-ink font-mono">{warm.tag}</code>. We file them into an
            “OutreachGraph Warmup” folder; if this address also forwards to Gmail, filter the copies
            there: Settings → Filters → Create filter → <em>Has the words</em>:
          </p>
          <div className="mt-1 flex items-center gap-2">
            <code className="border-border flex-1 truncate rounded-md border px-2 py-1 font-mono">
              {filter}
            </code>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(filter).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
              className="border-border min-h-[32px] rounded-lg border px-2"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="text-ink-muted mt-1">Then tick “Skip the Inbox” and “Mark as read”.</p>
        </div>
      ) : null}
    </div>
  );
}

function WarmStat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <dt className="text-ink-muted">{label}</dt>
      <dd className={`text-sm font-semibold tabular-nums ${tone ?? ''}`}>{value}</dd>
    </div>
  );
}

function RepliesLine({ mailbox }: { mailbox: MailboxView }) {
  if (!mailbox.readsReplies) {
    return (
      <p className="text-hot mt-3 text-xs">
        Replies to this mailbox are not being read: it has no IMAP server. Reconnect it with IMAP so
        answers reach the Inbox and stop follow-ups.
      </p>
    );
  }
  if (mailbox.repliesError) {
    return (
      <p className="text-hot mt-3 text-xs">
        We could not open this inbox{' '}
        {mailbox.repliesCheckedAt ? timeAgo(mailbox.repliesCheckedAt) : 'recently'}:{' '}
        {mailbox.repliesError}
      </p>
    );
  }
  return (
    <p className="text-ink-muted mt-3 text-xs">
      Reading replies
      {mailbox.repliesCheckedAt
        ? ` · inbox checked ${timeAgo(mailbox.repliesCheckedAt)}`
        : ' · first check within a few minutes'}
    </p>
  );
}

// ------------------------------------------------------------------- DNS check

interface DnsCheckView {
  status: 'pass' | 'warn' | 'fail';
  value?: string;
  detail: string;
}

interface DnsReportView {
  domain: string;
  mx: DnsCheckView;
  spf: DnsCheckView;
  dkim: DnsCheckView;
  dmarc: DnsCheckView;
  status: 'pass' | 'warn' | 'fail';
}

function DnsReport({ mailboxId }: { mailboxId: string }) {
  const [report, setReport] = useState<DnsReportView | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/v1/mailboxes/${mailboxId}/dns`, { credentials: 'same-origin', cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(await errorText(response));
        return (await response.json()) as { dns: DnsReportView };
      })
      .then((body) => !cancelled && setReport(body.dns))
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : 'the check failed');
      });
    return () => {
      cancelled = true;
    };
  }, [mailboxId]);

  return <DnsTable report={report} error={error} />;
}

function DnsTable({ report, error }: { report?: DnsReportView; error?: string }) {
  if (error) return <p className="text-hot mt-3 text-xs">{error}</p>;
  if (!report) return <p className="text-ink-muted mt-3 text-xs">Looking up DNS records…</p>;

  const rows: Array<[string, DnsCheckView]> = [
    ['SPF', report.spf],
    ['DKIM', report.dkim],
    ['DMARC', report.dmarc],
    ['MX', report.mx],
  ];

  return (
    <div className="border-border mt-3 rounded-xl border">
      <p className="border-border border-b px-3 py-2 text-xs font-medium">
        Domain check for {report.domain}
      </p>
      <ul className="divide-border divide-y">
        {rows.map(([name, check]) => (
          <li key={name} className="flex gap-3 px-3 py-2">
            <DnsIcon status={check.status} />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold">{name}</p>
              <p className="text-ink-muted text-xs">{check.detail}</p>
              {check.value ? (
                <p className="text-ink-muted mt-0.5 truncate font-mono text-[11px]">
                  {check.value}
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ----------------------------------------------------------------- add dialog

interface PresetView {
  id: string;
  label: string;
  host: string;
  port: number;
  secure: boolean;
  note?: string;
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
}

interface Detected {
  provider: string;
  providerLabel: string;
  smtp: { host: string; port: number; secure: boolean };
  imap: { host: string; port: number; secure: boolean } | null;
  source: 'known' | 'mx' | 'autoconfig' | 'guess';
  note: string | null;
}

/** The tiles on the first step. Google and Microsoft first, like everywhere else. */
const PROVIDER_TILES = [
  { id: 'gmail', title: 'Google', hint: 'Gmail or Google Workspace' },
  { id: 'microsoft', title: 'Microsoft', hint: 'Outlook or Microsoft 365' },
  { id: 'custom', title: 'Any other provider', hint: 'IMAP and SMTP, settings found for you' },
] as const;

const MORE_TILES = ['forwardemail', 'zoho', 'fastmail'] as const;

type Step = 'provider' | 'details' | 'connected';

function AddMailboxDialog({
  presets,
  initialEmail,
  onClose,
}: {
  presets: readonly PresetView[];
  initialEmail?: string | undefined;
  onClose: () => void;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(initialEmail ? 'details' : 'provider');
  const [providerId, setProviderId] = useState<string>('custom');

  const [email, setEmail] = useState(initialEmail ?? '');
  const [password, setPassword] = useState('');
  const [fromName, setFromName] = useState('');
  const [dailyCap, setDailyCap] = useState('50');
  const [warmup, setWarmup] = useState(true);

  const [host, setHost] = useState('');
  const [port, setPort] = useState(465);
  const [secure, setSecure] = useState(true);
  const [imapHost, setImapHost] = useState('');
  const [imapPort, setImapPort] = useState(993);
  const [username, setUsername] = useState('');
  const [advanced, setAdvanced] = useState(false);

  const [detected, setDetected] = useState<Detected | undefined>();
  const [detecting, setDetecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [connectedId, setConnectedId] = useState<string | undefined>();
  const lastDetected = useRef('');

  const preset = presets.find((p) => p.id === providerId);
  const note = detected?.note ?? (preset && preset.id !== 'custom' ? preset.note : undefined);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (initialEmail) void detect(initialEmail);
    // Only on open: a reconnect starts from the stored address.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyServers(next: {
    smtp: { host: string; port: number; secure: boolean };
    imap: { host: string; port: number; secure: boolean } | null;
  }): void {
    setHost(next.smtp.host);
    setPort(next.smtp.port);
    setSecure(next.smtp.secure);
    setImapHost(next.imap?.host ?? '');
    setImapPort(next.imap?.port ?? 993);
  }

  function choose(id: string): void {
    setProviderId(id);
    const chosen = presets.find((p) => p.id === id);
    if (chosen && chosen.id !== 'custom') {
      applyServers({
        smtp: { host: chosen.host, port: chosen.port, secure: chosen.secure },
        imap: chosen.imapHost
          ? { host: chosen.imapHost, port: chosen.imapPort ?? 993, secure: true }
          : null,
      });
    }
    setStep('details');
  }

  /** Looks the address up and fills the server fields. Returns what it applied. */
  async function detect(address: string, force = false): Promise<Detected | undefined> {
    const value = address.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return undefined;
    if (!force && value === lastDetected.current) return undefined;
    lastDetected.current = value;
    setDetecting(true);
    try {
      const response = await fetch('/api/v1/mailboxes/detect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email: value }),
      });
      if (!response.ok) return undefined;
      const { detected: found } = (await response.json()) as { detected: Detected };
      setDetected(found);
      if (found.source === 'guess') setAdvanced(true);
      // A tile picked by hand wins over a guess, never over a sure answer.
      if (providerId === 'custom' || found.source !== 'guess') {
        applyServers(found);
        if (found.provider !== 'custom') setProviderId(found.provider);
        return found;
      }
      return undefined;
    } catch {
      // Detection is a convenience; the advanced fields still work without it.
      return undefined;
    } finally {
      setDetecting(false);
    }
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(undefined);

    // State set by a detection inside this handler is not visible until the
    // next render, so the servers sent are whichever is freshest here.
    let servers = {
      smtp: { host, port: Number(port), secure },
      imap: imapHost.trim() ? { host: imapHost.trim(), port: Number(imapPort) } : null,
    };
    if (!servers.smtp.host) {
      const found = await detect(email, true);
      if (found) servers = { smtp: found.smtp, imap: found.imap };
    }
    if (!servers.smtp.host) {
      setAdvanced(true);
      setError('Enter the SMTP server under Server settings.');
      return;
    }

    setBusy(true);
    try {
      const response = await fetch('/api/v1/integrations/email', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          host: servers.smtp.host,
          port: servers.smtp.port,
          secure: servers.smtp.secure,
          username: username.trim() || email.trim(),
          password,
          fromEmail: email.trim(),
          ...(fromName.trim() ? { fromName: fromName.trim() } : {}),
          ...(servers.imap
            ? { imapHost: servers.imap.host, imapPort: servers.imap.port, imapSecure: true }
            : {}),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        account?: { accountId?: string };
        error?: { message?: string };
      };
      if (!response.ok) {
        // The mail server's own words: "535 Authentication failed" says
        // "check the app password", which "that failed" never could.
        setError(body.error?.message ?? `that failed (${response.status})`);
        return;
      }

      const accountId = body.account?.accountId;
      if (accountId) {
        const cap = Number(dailyCap);
        await fetch(`/api/v1/senders/${accountId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            ...(Number.isInteger(cap) && cap >= 0 ? { dailyCap: cap } : {}),
            warmup,
          }),
        }).catch(() => undefined);
      }

      setPassword('');
      setConnectedId(accountId);
      setStep('connected');
      router.refresh();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 sm:items-center"
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-mailbox-title"
        className="bg-surface border-border max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-2xl border p-5 sm:rounded-2xl"
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id="add-mailbox-title" className="text-base font-semibold">
            {step === 'connected'
              ? 'Mailbox connected'
              : step === 'provider'
                ? 'Add a mailbox'
                : `Connect ${providerName(providerId, presets)}`}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-ink-muted min-h-[36px] px-2 text-lg"
          >
            ×
          </button>
        </div>

        {step === 'provider' ? (
          <div className="flex flex-col gap-2">
            <p className="text-ink-muted mb-1 text-sm">Where does this address live?</p>
            {PROVIDER_TILES.map((tile) => (
              <ProviderTile
                key={tile.id}
                title={tile.title}
                hint={tile.hint}
                onClick={() => choose(tile.id)}
              />
            ))}
            <div className="mt-1 flex flex-wrap gap-2">
              {MORE_TILES.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => choose(id)}
                  className="border-border min-h-[36px] rounded-xl border px-3 text-xs"
                >
                  {providerName(id, presets)}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {step === 'details' ? (
          <form onSubmit={submit} className="flex flex-col gap-3">
            <Field label="Email address">
              <input
                type="email"
                required
                autoFocus={!initialEmail}
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                onBlur={() => void detect(email)}
                placeholder="you@company.com"
                className={INPUT}
              />
            </Field>

            {detecting ? (
              <p className="text-ink-muted text-xs">Finding this mailbox’s servers…</p>
            ) : detected && host ? (
              <p className="border-border text-ink-muted rounded-xl border px-3 py-2 text-xs">
                <span className="text-ink font-medium">
                  {detected.source === 'guess' ? 'Best guess' : `Found: ${detected.providerLabel}`}
                </span>
                {' · '}
                sends via {host}:{port}
                {imapHost ? `, reads via ${imapHost}:${imapPort}` : ''}
              </p>
            ) : null}

            <Field label={providerId === 'gmail' ? 'App password' : 'Password or app password'}>
              <input
                type="password"
                required
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className={INPUT}
              />
            </Field>

            {note ? (
              <p className="border-border text-ink-muted rounded-xl border border-dashed p-3 text-xs">
                {note}
              </p>
            ) : null}

            <Field label="Sender name (optional)">
              <input
                value={fromName}
                onChange={(event) => setFromName(event.target.value)}
                placeholder="Jane from Acme"
                className={INPUT}
              />
            </Field>

            <div className="grid grid-cols-[auto_1fr] items-center gap-3">
              <Field label="Daily limit">
                <input
                  inputMode="numeric"
                  value={dailyCap}
                  onChange={(event) => setDailyCap(event.target.value)}
                  className={`${INPUT} w-24 tabular-nums`}
                />
              </Field>
              <label className="mt-4 flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={warmup}
                  onChange={(event) => setWarmup(event.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  Warm up first: start at 5 a day and climb to the limit over a couple of weeks.
                </span>
              </label>
            </div>

            <button
              type="button"
              onClick={() => setAdvanced((v) => !v)}
              className="text-accent self-start text-xs font-medium"
            >
              {advanced ? 'Hide server settings' : 'Server settings'}
            </button>

            {advanced ? (
              <div className="border-border flex flex-col gap-3 rounded-xl border p-3">
                <div className="grid grid-cols-3 gap-2">
                  <Field label="SMTP server" className="col-span-2">
                    <input
                      value={host}
                      onChange={(event) => setHost(event.target.value)}
                      placeholder="smtp.example.com"
                      className={INPUT}
                    />
                  </Field>
                  <Field label="Port">
                    <input
                      type="number"
                      value={port}
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        setPort(next);
                        if (next === 465) setSecure(true);
                        if (next === 587 || next === 25) setSecure(false);
                      }}
                      className={INPUT}
                    />
                  </Field>
                </div>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={secure}
                    onChange={(event) => setSecure(event.target.checked)}
                  />
                  TLS on connect (465). Off for STARTTLS (587).
                </label>
                <div className="grid grid-cols-3 gap-2">
                  <Field label="IMAP server (reads replies)" className="col-span-2">
                    <input
                      value={imapHost}
                      onChange={(event) => setImapHost(event.target.value)}
                      placeholder="imap.example.com"
                      className={INPUT}
                    />
                  </Field>
                  <Field label="Port">
                    <input
                      type="number"
                      value={imapPort}
                      onChange={(event) => setImapPort(Number(event.target.value))}
                      className={INPUT}
                    />
                  </Field>
                </div>
                <Field label="Login, if not the address">
                  <input
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    placeholder={email || 'you@company.com'}
                    autoComplete="username"
                    className={INPUT}
                  />
                </Field>
              </div>
            ) : null}

            {error ? (
              <p role="alert" className="text-hot text-sm">
                {error}
              </p>
            ) : null}

            <div className="flex gap-2">
              {!initialEmail ? (
                <button
                  type="button"
                  onClick={() => setStep('provider')}
                  className="border-border min-h-[40px] rounded-xl border px-4 text-sm"
                >
                  Back
                </button>
              ) : null}
              <button
                type="submit"
                disabled={busy}
                className="bg-accent min-h-[40px] flex-1 rounded-xl text-sm font-medium text-white disabled:opacity-60"
              >
                {busy ? 'Logging in to send and read…' : 'Connect mailbox'}
              </button>
            </div>
            <p className="text-ink-muted text-center text-xs">
              We log in before saving, so a mailbox that connects works. The password is stored
              encrypted and never shown again.
            </p>
          </form>
        ) : null}

        {step === 'connected' ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm">
              <span className="font-medium">{email}</span> can send and its replies will reach your
              Inbox. {warmup ? 'Warm-up has started.' : ''}
            </p>
            {connectedId ? <DnsReport mailboxId={connectedId} /> : null}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setStep('provider');
                  setEmail('');
                  setDetected(undefined);
                  lastDetected.current = '';
                  setHost('');
                  setImapHost('');
                  setFromName('');
                }}
                className="border-border min-h-[40px] flex-1 rounded-xl border text-sm"
              >
                Add another
              </button>
              <button
                type="button"
                onClick={onClose}
                className="bg-accent min-h-[40px] flex-1 rounded-xl text-sm font-medium text-white"
              >
                Done
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ small parts

const INPUT = 'border-border bg-surface text-ink mt-1 w-full rounded-xl border p-2 text-sm';

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={`text-sm ${className ?? ''}`}>
      <span className="text-ink-muted text-xs">{label}</span>
      {children}
    </label>
  );
}

function ProviderTile({
  title,
  hint,
  onClick,
}: {
  title: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="border-border bg-surface-raised hover:border-accent flex min-h-[56px] items-center justify-between gap-3 rounded-xl border px-4 text-left"
    >
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="text-ink-muted block text-xs">{hint}</span>
      </span>
      <span aria-hidden className="text-ink-muted">
        ›
      </span>
    </button>
  );
}

function SmallButton({
  children,
  onClick,
  disabled,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: 'button' | 'submit';
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="border-border min-h-[36px] rounded-xl border px-3 text-xs disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function Meter({
  label,
  value,
  share,
  tone,
}: {
  label: string;
  value: string;
  share: number;
  tone: string;
}) {
  return (
    <div>
      <div className="text-ink-muted flex justify-between text-xs">
        <span>{label}</span>
        <span className="tabular-nums">{value}</span>
      </div>
      <div className="bg-surface mt-1 h-1.5 overflow-hidden rounded-full">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${share}%` }} />
      </div>
    </div>
  );
}

function HealthScore({ score }: { score: number }) {
  const tone = score >= 80 ? 'text-good' : score >= 50 ? 'text-amber-600' : 'text-hot';
  return (
    <span
      title="Health: climbs as the mailbox warms up; drops for bounces, a stopped account or unread replies"
      className={`border-border flex h-10 w-12 shrink-0 flex-col items-center justify-center rounded-xl border ${tone}`}
    >
      <span className="text-sm leading-none font-semibold tabular-nums">{score}</span>
      <span className="text-ink-muted text-[9px] tracking-wide uppercase">health</span>
    </span>
  );
}

function RiskChip({ risk }: { risk: 'low' | 'medium' | 'high' }) {
  const tone =
    risk === 'low'
      ? 'bg-emerald-500/15 text-emerald-600'
      : risk === 'medium'
        ? 'bg-amber-500/15 text-amber-600'
        : 'bg-rose-500/15 text-rose-600';
  return (
    <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}>
      {risk === 'low' ? 'Low' : risk === 'medium' ? 'Medium' : 'High'}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'active'
      ? 'bg-emerald-500/15 text-emerald-600'
      : status === 'paused'
        ? 'bg-amber-500/15 text-amber-600'
        : 'bg-rose-500/15 text-rose-600';
  const label =
    status === 'active'
      ? 'Active'
      : status === 'paused'
        ? 'Paused'
        : status === 'revoked'
          ? 'Signed out'
          : 'Stopped';
  return (
    <span className={`shrink-0 self-center rounded-full px-2 py-1 text-[11px] font-medium ${tone}`}>
      {label}
    </span>
  );
}

function DnsIcon({ status }: { status: 'pass' | 'warn' | 'fail' }) {
  const [glyph, tone] =
    status === 'pass'
      ? ['✓', 'bg-emerald-500/15 text-emerald-600']
      : status === 'warn'
        ? ['!', 'bg-amber-500/15 text-amber-600']
        : ['✕', 'bg-rose-500/15 text-rose-600'];
  return (
    <span
      aria-label={status}
      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${tone}`}
    >
      {glyph}
    </span>
  );
}

function MailIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="text-accent h-10 w-10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </svg>
  );
}

function providerName(id: string, presets: readonly PresetView[]): string {
  if (id === 'custom') return 'a mailbox';
  return presets.find((p) => p.id === id)?.label ?? id;
}

async function errorText(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
  return body.error?.message ?? `that failed (${response.status})`;
}

function timeAgo(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

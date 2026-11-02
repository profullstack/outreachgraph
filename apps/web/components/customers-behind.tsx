'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { BehindCustomerView, CoinPayBehindView } from '../lib/api';
import { draftFollowUp, owedText } from '../lib/payment-followup';

const SHOWN = 6;

/**
 * Today: the people who owe this workspace money, from its own CoinPay account.
 *
 * Sylo's "who needs you today, and why" for an existing customer instead of a
 * prospect. One sentence first, then the people in the order CoinPay grouped
 * them (what to do), each with the reason, whether it is a habit, and an email
 * the person sends from their own mail. Nothing here enters the outreach queue.
 */
export function CustomersBehind({ view }: { view: CoinPayBehindView }) {
  if (view.state === 'not_connected') {
    return (
      <Link
        href="/settings#coinpay"
        className="border-border text-ink-muted mb-5 block rounded-2xl border border-dashed p-4 text-sm"
      >
        <span className="text-ink font-medium">Sell through CoinPay?</span> Connect it to see
        customers behind on paying you, and what to do about each, right here.
      </Link>
    );
  }

  if (view.state === 'locked' || view.state === 'error') {
    return (
      <Section title="Customers behind on payments">
        <p className="text-ink-muted text-sm">
          {view.state === 'locked' ? (
            <>
              Your workspace keys are locked, so the CoinPay key cannot be read.{' '}
              <Link href="/keys" className="text-accent">
                Unlock them
              </Link>
              .
            </>
          ) : (
            view.message
          )}
        </p>
      </Section>
    );
  }

  if (view.counts.customers === 0) {
    return (
      <Section title="Customers behind on payments">
        <p className="text-ink-muted text-sm">{view.summary}</p>
      </Section>
    );
  }

  const people = view.groups.flatMap((g) => g.customers.map((c) => ({ group: g, customer: c })));
  const rest = people.length - SHOWN;

  return (
    <Section title="Customers behind on payments">
      <p className="mb-3 text-sm">{view.summary}</p>
      <div className="flex flex-col gap-3">
        {people.slice(0, SHOWN).map(({ group, customer }) => (
          <CustomerCard
            key={customer.key}
            customer={customer}
            todo={group.title}
            portalUrl={view.portal_url}
          />
        ))}
      </div>
      {rest > 0 ? (
        <a
          href={`${view.portal_url}/payments/behind`}
          target="_blank"
          rel="noreferrer"
          className="text-accent mt-3 inline-block text-sm"
        >
          {rest} more in CoinPay →
        </a>
      ) : null}
    </Section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <h2 className="text-ink-muted mb-2 text-[11px] font-semibold tracking-wide uppercase">
        {title}
      </h2>
      {children}
    </section>
  );
}

function CustomerCard({
  customer,
  todo,
  portalUrl,
}: {
  customer: BehindCustomerView;
  todo: string;
  portalUrl: string;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const draft = draftFollowUp(customer);
  const latest = customer.items[0];

  async function copy(): Promise<void> {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(`Subject: ${draft.subject}\n\n${draft.body}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setOpen(true);
    }
  }

  return (
    <article className="border-border bg-surface-raised rounded-2xl border p-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate font-semibold">{customer.name}</span>
        <span className="font-semibold tabular-nums">{owedText(customer)}</span>
      </div>
      <p className="text-accent mt-1 text-xs font-medium">{todo}</p>
      {latest ? (
        <p className="mt-2 text-sm">
          <a
            href={`${portalUrl}${latest.href}`}
            target="_blank"
            rel="noreferrer"
            className="font-medium"
          >
            {latest.title}
          </a>
          <span className="text-ink-muted"> · {latest.detail}</span>
          {customer.items.length > 1 ? (
            <span className="text-ink-muted"> · +{customer.items.length - 1} more</span>
          ) : null}
        </p>
      ) : null}
      <p className="text-ink-muted mt-1 text-xs">{customer.history.line}</p>

      {draft ? (
        <>
          <div className="mt-3 flex flex-wrap gap-2">
            <a
              href={draft.mailto}
              className="bg-accent rounded-xl px-3 py-2 text-xs font-medium text-white"
            >
              Email {customer.name.split(/\s+/)[0]}
            </a>
            <button
              type="button"
              onClick={copy}
              className="border-border rounded-xl border px-3 py-2 text-xs font-medium"
            >
              {copied ? 'Copied' : 'Copy email'}
            </button>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="text-ink-muted px-1 py-2 text-xs"
              aria-expanded={open}
            >
              {open ? 'Hide draft' : 'Show draft'}
            </button>
          </div>
          {open ? (
            <pre className="border-border text-ink-muted mt-2 rounded-xl border p-3 text-xs whitespace-pre-wrap">
              {`To: ${draft.to}\nSubject: ${draft.subject}\n\n${draft.body}`}
            </pre>
          ) : null}
        </>
      ) : (
        <p className="text-ink-muted mt-2 text-xs">No email address on file in CoinPay.</p>
      )}
    </article>
  );
}

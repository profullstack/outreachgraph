'use client';

import { useEffect, useState } from 'react';

/**
 * The leads screening is holding back, each with its reason and an Allow.
 *
 * Held, not hidden: a relay mailbox or a role inbox can still be the right
 * person, and the owner is the one who knows. Allowing one clears the hold
 * for every send path at once, because the hold lives in the policy engine.
 */

interface ScreenedLead {
  readonly person_id: string;
  readonly name: string;
  readonly email: string | null;
  readonly reasons: readonly { flag: string; detail: string }[];
  readonly held: boolean;
}

const FLAG_LABEL: Readonly<Record<string, string>> = {
  generated_name: 'generated name',
  relay_address: 'relay address',
  temp_mail_domain: 'temp-mail domain',
  agent_account: 'bot or test account',
  role_address: 'role inbox',
};

export function ScreenedLeads({ campaignId }: { campaignId: string }) {
  const [leads, setLeads] = useState<ScreenedLead[] | undefined>();
  const [held, setHeld] = useState(0);
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/v1/autogtm/campaigns/${encodeURIComponent(campaignId)}/screened?limit=50`, {
      credentials: 'same-origin',
    })
      .then(async (response) => {
        if (!response.ok || cancelled) return;
        const body = (await response.json()) as { held: number; leads: ScreenedLead[] };
        setLeads(body.leads);
        setHeld(body.held);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [campaignId]);

  async function allow(personId: string): Promise<void> {
    setBusy(personId);
    setError(undefined);
    try {
      const response = await fetch(
        `/api/v1/autogtm/leads/${encodeURIComponent(personId)}/screening`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ allow: true }),
        },
      );
      if (!response.ok) {
        setError(`Could not allow that lead (${response.status}).`);
        return;
      }
      setLeads((current) => current?.filter((lead) => lead.person_id !== personId));
      setHeld((n) => Math.max(0, n - 1));
    } finally {
      setBusy(undefined);
    }
  }

  if (!leads || held === 0) return null;

  return (
    <details className="border-border bg-surface-raised mb-3 rounded-xl border p-3 text-sm">
      <summary className="cursor-pointer font-medium">
        {held.toLocaleString()} {held === 1 ? 'lead' : 'leads'} held back by screening
      </summary>
      <p className="text-ink-muted mt-1 text-xs">
        Imported, researched, not written to. Allow one to send to them anyway.
      </p>
      <ul className="divide-border mt-2 divide-y">
        {leads.map((lead) => (
          <li key={lead.person_id} className="flex items-start gap-2 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">
                {lead.name}
                {lead.email ? <span className="text-ink-muted"> · {lead.email}</span> : null}
              </div>
              <div className="text-ink-muted text-xs">
                {lead.reasons
                  .map((reason) => `${FLAG_LABEL[reason.flag] ?? reason.flag}: ${reason.detail}`)
                  .join('; ')}
              </div>
            </div>
            <button
              type="button"
              disabled={busy === lead.person_id}
              onClick={() => void allow(lead.person_id)}
              className="border-border shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium disabled:opacity-40"
            >
              Allow
            </button>
          </li>
        ))}
      </ul>
      {error ? (
        <p role="alert" className="text-hot mt-2 text-xs">
          {error}
        </p>
      ) : null}
    </details>
  );
}

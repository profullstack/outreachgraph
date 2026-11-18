'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Member introductions (PRD §38): your card, switched on with one click; the
 * people worth meeting; and the requests between you. Every introduction needs
 * both sides to say yes, and only then does either see the other's email.
 */

interface Card {
  id: string | null;
  open: boolean;
  displayName: string;
  headline: string;
  lookingFor: string;
  canOffer: string;
  topics: string[];
}

interface CardState {
  card: Card;
  drafted: boolean;
  mailOff: boolean;
  previewMatches: number;
}

interface Match {
  card: { id: string; displayName: string; headline: string; lookingFor: string; canOffer: string };
  score: number;
  theyOffer: string[];
  youOffer: string[];
}

interface Request {
  id: string;
  direction: 'incoming' | 'outgoing';
  status: string;
  note: string;
  card: { displayName: string; headline: string; canOffer: string };
  contact?: { email: string };
  createdAt: string;
}

const input = 'border-border bg-surface mt-1 block w-full rounded-xl border px-3 py-2 text-sm';
const button = 'bg-accent rounded-xl px-4 py-2 text-sm font-medium text-white disabled:opacity-60';
const quiet = 'border-border rounded-xl border px-3 py-1.5 text-sm';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1/intros${path}`, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message ?? `request failed (${response.status})`);
  return body;
}

export function IntrosPanel() {
  const [state, setState] = useState<CardState | null>(null);
  const [matches, setMatches] = useState<Match[]>([]);
  const [requests, setRequests] = useState<Request[]>([]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Card | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const s = await api<CardState>('/card');
      setState(s);
      setDraft(s.card);
      const r = await api<{ requests: Request[] }>('/requests');
      setRequests(r.requests);
      if (s.card.open) {
        const m = await api<{ matches: Match[] }>('/matches?limit=20');
        setMatches(m.matches);
      } else {
        setMatches([]);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await api('/card', { method: 'PUT', body: JSON.stringify(body) });
      setEditing(false);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!state || !draft) {
    return <p className="text-ink-muted text-sm">{error ?? 'Loading…'}</p>;
  }
  const { card } = state;
  const incoming = requests.filter((r) => r.direction === 'incoming');
  const outgoing = requests.filter((r) => r.direction === 'outgoing');

  return (
    <div className="space-y-6">
      {error ? <p className="text-hot text-sm">{error}</p> : null}

      <section className="border-border rounded-2xl border p-4" aria-label="Your card">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="mr-auto text-lg font-semibold">Your intro card</h2>
          <span className={`text-xs ${card.open ? 'text-good' : 'text-ink-muted'}`}>
            {card.open ? 'On: members can find you' : 'Off: nobody sees it'}
          </span>
        </div>
        {!card.open && state.previewMatches > 0 ? (
          <p className="mt-2 text-sm">
            <strong>{state.previewMatches}</strong>{' '}
            {state.previewMatches === 1 ? 'member looks' : 'members look'} like a fit. Turn your
            card on to see them.
          </p>
        ) : null}
        {state.drafted ? (
          <p className="text-ink-muted mt-1 text-xs">
            We wrote this from your profile and products. Edit anything and it is yours.
          </p>
        ) : null}

        {editing ? (
          <form
            className="mt-3 grid gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void save({
                displayName: draft.displayName,
                headline: draft.headline,
                lookingFor: draft.lookingFor,
                canOffer: draft.canOffer,
              });
            }}
          >
            <label className="text-sm">
              Name
              <input
                className={input}
                value={draft.displayName}
                onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
              />
            </label>
            <label className="text-sm">
              Headline
              <input
                className={input}
                value={draft.headline}
                onChange={(e) => setDraft({ ...draft, headline: e.target.value })}
              />
            </label>
            <label className="text-sm">
              Who you want to meet
              <textarea
                className={input}
                rows={3}
                value={draft.lookingFor}
                onChange={(e) => setDraft({ ...draft, lookingFor: e.target.value })}
              />
            </label>
            <label className="text-sm">
              What you can offer them
              <textarea
                className={input}
                rows={3}
                value={draft.canOffer}
                onChange={(e) => setDraft({ ...draft, canOffer: e.target.value })}
              />
            </label>
            <div className="flex gap-2">
              <button type="submit" disabled={busy} className={button}>
                Save
              </button>
              <button type="button" className={quiet} onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <dl className="mt-3 space-y-2 text-sm">
            <div>
              <dt className="font-medium">{card.displayName || 'No name yet'}</dt>
              <dd className="text-ink-muted">{card.headline}</dd>
            </div>
            <div>
              <dt className="text-ink-muted text-xs uppercase">Wants to meet</dt>
              <dd>{card.lookingFor || '—'}</dd>
            </div>
            <div>
              <dt className="text-ink-muted text-xs uppercase">Can offer</dt>
              <dd>{card.canOffer || '—'}</dd>
            </div>
          </dl>
        )}

        {!editing ? (
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              className={card.open ? quiet : button}
              onClick={() => void save({ open: !card.open })}
            >
              {card.open ? 'Turn off' : 'Turn on'}
            </button>
            <button type="button" className={quiet} onClick={() => setEditing(true)}>
              Edit
            </button>
          </div>
        ) : null}
        <label id="mail" className="text-ink-muted mt-4 flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={!state.mailOff}
            onChange={(e) =>
              void api('/mail', {
                method: 'PUT',
                body: JSON.stringify({ on: e.target.checked }),
              }).then(load)
            }
          />
          Weekly email with people worth meeting
        </label>
      </section>

      {incoming.length ? (
        <section aria-label="Requests for you">
          <h2 className="mb-2 text-lg font-semibold">Asked to meet you</h2>
          <ul className="space-y-3">
            {incoming.map((r) => (
              <RequestItem key={r.id} request={r} onChanged={load} />
            ))}
          </ul>
        </section>
      ) : null}

      {card.open ? (
        <section aria-label="Matches">
          <h2 className="mb-2 text-lg font-semibold">People worth meeting</h2>
          {matches.length === 0 ? (
            <p className="border-border text-ink-muted rounded-2xl border border-dashed p-6 text-center text-sm">
              No matches yet. New members join every week; you will get an email.
            </p>
          ) : (
            <ul className="space-y-3">
              {matches.map((m) => (
                <MatchItem key={m.card.id} match={m} onAsked={load} />
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {outgoing.length ? (
        <section aria-label="Your requests">
          <h2 className="mb-2 text-lg font-semibold">You asked</h2>
          <ul className="space-y-3">
            {outgoing.map((r) => (
              <RequestItem key={r.id} request={r} onChanged={load} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function MatchItem({ match, onAsked }: { match: Match; onAsked: () => Promise<void> }) {
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const why = [...match.theyOffer, ...match.youOffer].slice(0, 6);
  return (
    <li className="border-border rounded-2xl border p-4 text-sm">
      <p className="font-medium">{match.card.displayName}</p>
      <p className="text-ink-muted">{match.card.headline}</p>
      <p className="mt-2">
        <span className="text-ink-muted text-xs uppercase">Offers </span>
        {match.card.canOffer}
      </p>
      <p className="mt-1">
        <span className="text-ink-muted text-xs uppercase">Wants </span>
        {match.card.lookingFor}
      </p>
      {why.length ? (
        <p className="text-ink-muted mt-1 text-xs">Matched on: {why.join(', ')}</p>
      ) : null}
      {asking ? (
        <form
          className="mt-3"
          onSubmit={(e) => {
            e.preventDefault();
            void api('/requests', {
              method: 'POST',
              body: JSON.stringify({ cardId: match.card.id, note }),
            })
              .then(onAsked)
              .catch((err: Error) => setError(err.message));
          }}
        >
          <textarea
            className={input}
            rows={2}
            required
            placeholder="Why you would like to meet"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          {error ? <p className="text-hot mt-1 text-xs">{error}</p> : null}
          <button type="submit" className={`${button} mt-2`}>
            Ask for an intro
          </button>
        </form>
      ) : (
        <button type="button" className={`${quiet} mt-3`} onClick={() => setAsking(true)}>
          Ask for an intro
        </button>
      )}
    </li>
  );
}

function RequestItem({ request, onChanged }: { request: Request; onChanged: () => Promise<void> }) {
  const act = (response: 'accept' | 'decline' | 'withdraw') =>
    void api(`/requests/${request.id}/${response}`, { method: 'POST' }).then(onChanged);
  return (
    <li className="border-border rounded-2xl border p-4 text-sm">
      <p className="font-medium">
        {request.card.displayName}{' '}
        <span className="text-ink-muted text-xs">· {request.status}</span>
      </p>
      <p className="text-ink-muted">{request.card.headline}</p>
      <p className="mt-2 whitespace-pre-line">{request.note}</p>
      {request.contact ? (
        <p className="mt-2">
          Reach them at{' '}
          <a className="text-accent underline" href={`mailto:${request.contact.email}`}>
            {request.contact.email}
          </a>
        </p>
      ) : null}
      {request.status === 'pending' ? (
        <div className="mt-3 flex gap-2">
          {request.direction === 'incoming' ? (
            <>
              <button type="button" className={button} onClick={() => act('accept')}>
                Accept
              </button>
              <button type="button" className={quiet} onClick={() => act('decline')}>
                Decline
              </button>
            </>
          ) : (
            <button type="button" className={quiet} onClick={() => act('withdraw')}>
              Withdraw
            </button>
          )}
        </div>
      ) : null}
    </li>
  );
}

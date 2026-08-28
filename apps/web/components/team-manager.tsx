'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { TeamInvitationView, TeamMemberView } from '../lib/types';

/**
 * Adding and removing the people in an organization.
 *
 * One component rather than three, because the three lists are one question —
 * who can get at this account — and splitting them across cards makes a seat
 * that was invited but never accepted easy to lose track of. Pending
 * invitations are shown beside members for the same reason: an unanswered
 * invitation is a seat already committed.
 *
 * `canManage` comes from the API rather than being inferred from the role
 * string here. The server is what enforces it, and a second copy of the rule
 * in the client is a second copy that can disagree.
 */
export function TeamManager({
  members,
  invitations,
  canManage,
  currentUserId,
}: {
  members: TeamMemberView[];
  invitations: TeamInvitationView[];
  canManage: boolean;
  currentUserId: string | undefined;
}) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();

  async function invite(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!email.trim()) return;

    setBusy(true);
    setError(undefined);
    setNote(undefined);

    try {
      const response = await fetch('/api/v1/team/invitations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email, role }),
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(payload?.error?.message ?? `that failed (${response.status})`);
        return;
      }

      // Whether the mail actually left matters: the invitation exists either
      // way, and a page that says "invited" after a failed send sends someone
      // off to wait for a message that is never coming.
      setNote(
        payload.sent
          ? `Invited ${payload.email}. The link expires in 14 days.`
          : `Invited ${payload.email}, but the email could not be sent. Withdraw and try again.`,
      );

      setEmail('');
      router.refresh();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  async function act(key: string, path: string, confirmText: string): Promise<void> {
    if (!confirm(confirmText)) return;

    setPending(key);
    setError(undefined);
    setNote(undefined);

    try {
      const response = await fetch(path, { method: 'DELETE', credentials: 'same-origin' });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setError(payload?.error?.message ?? `that failed (${response.status})`);
        return;
      }

      router.refresh();
    } catch {
      setError('could not reach the server');
    } finally {
      setPending(undefined);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {canManage ? (
        <form onSubmit={invite} className="border-border bg-surface-raised rounded-2xl border p-4">
          <label htmlFor="invite-email" className="text-sm font-medium">
            Invite a teammate
          </label>
          <p className="text-ink-muted mt-1 text-xs">
            They get a link that works whether or not they already have an account.
          </p>

          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input
              id="invite-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="colleague@company.com"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="border-border bg-surface min-w-0 flex-1 rounded-xl border px-3 py-3"
            />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              aria-label="Role"
              className="border-border bg-surface shrink-0 rounded-xl border px-3 py-3 text-sm"
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
              <option value="viewer">Viewer</option>
            </select>
            <button
              type="submit"
              disabled={busy || !email.trim()}
              className="bg-accent shrink-0 rounded-xl px-4 py-3 text-sm font-medium text-white disabled:opacity-40"
            >
              {busy ? 'Inviting…' : 'Invite'}
            </button>
          </div>

          <p className="text-ink-muted mt-2 text-[13px] leading-relaxed">
            A <span className="font-medium">member</span> can run campaigns and approve messages. An{' '}
            <span className="font-medium">admin</span> can also invite and remove people. A{' '}
            <span className="font-medium">viewer</span> can only read.
          </p>

          {note ? <p className="text-ink-muted mt-3 text-sm">{note}</p> : null}

          {error ? (
            <p role="alert" className="text-hot mt-3 text-sm">
              {error}
            </p>
          ) : null}
        </form>
      ) : null}

      <section>
        <h2 className="text-ink-muted mb-2 text-[11px] font-semibold tracking-wide uppercase">
          On the team
        </h2>

        <ul className="border-border divide-border divide-y overflow-hidden rounded-2xl border">
          {members.map((member) => (
            <li
              key={member.userId}
              className="bg-surface-raised flex items-start justify-between gap-3 p-4"
            >
              <div className="min-w-0">
                <div className="truncate font-medium">{member.name ?? member.email}</div>
                <div className="text-ink-muted truncate text-xs">
                  {member.name ? `${member.email} · ` : ''}
                  {member.role}
                  {member.userId === currentUserId ? ' · you' : ''}
                </div>
              </div>

              {/* The owner row has no remove button: the API refuses to leave
                  an organization with no owner, and offering a control that
                  always errors is worse than not offering it. */}
              {canManage && member.userId !== currentUserId && member.role !== 'owner' ? (
                <button
                  type="button"
                  disabled={pending === member.userId}
                  onClick={() =>
                    void act(
                      member.userId,
                      `/api/v1/team/members/${encodeURIComponent(member.userId)}`,
                      `Remove ${member.email} from this team?`,
                    )
                  }
                  className="text-ink-muted shrink-0 text-xs underline disabled:opacity-40"
                >
                  {pending === member.userId ? 'Removing…' : 'Remove'}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      {invitations.length > 0 ? (
        <section>
          <h2 className="text-ink-muted mb-2 text-[11px] font-semibold tracking-wide uppercase">
            Invited, not answered
          </h2>

          <ul className="border-border divide-border divide-y overflow-hidden rounded-2xl border">
            {invitations.map((invitation) => (
              <li
                key={invitation.id}
                className="bg-surface-raised flex items-start justify-between gap-3 p-4"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{invitation.email}</div>
                  <div className="text-ink-muted truncate text-xs">
                    {invitation.role}
                    {invitation.expired ? ' · expired' : ''}
                    {invitation.invitedBy ? ` · invited by ${invitation.invitedBy}` : ''}
                  </div>
                </div>

                {canManage ? (
                  <button
                    type="button"
                    disabled={pending === invitation.id}
                    onClick={() =>
                      void act(
                        invitation.id,
                        `/api/v1/team/invitations/${encodeURIComponent(invitation.id)}`,
                        `Withdraw the invitation to ${invitation.email}? Their link stops working.`,
                      )
                    }
                    className="text-ink-muted shrink-0 text-xs underline disabled:opacity-40"
                  >
                    {pending === invitation.id ? 'Withdrawing…' : 'Withdraw'}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

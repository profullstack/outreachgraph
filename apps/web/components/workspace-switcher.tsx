'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { WorkspaceOptionView } from '../lib/types';

/**
 * Moving between workspaces, and making a new one.
 *
 * `organizations → workspaces` has been in the schema since the first
 * migration — it is how an agency keeps one client's prospect graph out of
 * another's — and nothing in the product could create a second workspace or
 * move to one. `sessions.workspace_id` was written at login and never again.
 *
 * Hidden entirely for an account with one workspace and no permission to add
 * another, which is almost everybody. A switcher offering a single choice is a
 * control that only ever raises the question of what it is for.
 *
 * Switching is a server round trip rather than client state because the thing
 * that changes is which workspace the *session* is pinned to: every server
 * component reads it from the session on the next request, so nothing short of
 * a refresh would be honest about what happened.
 */
export function WorkspaceSwitcher({
  workspaces,
  currentId,
  canCreate,
}: {
  workspaces: WorkspaceOptionView[];
  currentId: string;
  canCreate: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | undefined>();

  if (workspaces.length < 2 && !canCreate) return null;

  async function post(path: string, body?: unknown): Promise<Response | undefined> {
    setBusy(true);
    setError(undefined);

    try {
      return await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
    } catch {
      setError('could not reach the server');
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  async function switchTo(id: string): Promise<void> {
    if (id === currentId) return;

    const response = await post(`/api/v1/workspaces/${encodeURIComponent(id)}/switch`);
    if (!response) return;

    if (!response.ok) {
      setError(`could not switch (${response.status})`);
      return;
    }

    router.replace('/today');
    router.refresh();
  }

  async function create(): Promise<void> {
    if (!name.trim()) return;

    const response = await post('/api/v1/workspaces', { name });
    if (!response) return;

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      setError(payload?.error?.message ?? `could not create that (${response.status})`);
      return;
    }

    // Land in the workspace just made. Creating one and staying where you were
    // reads as though nothing happened.
    setName('');
    setAdding(false);
    await switchTo(payload.workspace.id);
  }

  return (
    <section className="mb-6">
      <h2 className="text-ink-muted mb-2 text-[11px] font-semibold tracking-wide uppercase">
        Workspace
      </h2>

      <ul className="border-border divide-border divide-y overflow-hidden rounded-2xl border">
        {workspaces.map((workspace) => (
          <li key={workspace.id}>
            <button
              type="button"
              onClick={() => void switchTo(workspace.id)}
              disabled={busy}
              aria-current={workspace.id === currentId ? 'true' : undefined}
              className="bg-surface-raised flex w-full items-center justify-between gap-3 p-4 text-left disabled:opacity-40"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{workspace.name}</span>
                <span className="text-ink-muted block text-xs">{workspace.role}</span>
              </span>

              {workspace.id === currentId ? (
                <span className="text-accent shrink-0 text-[11px]">current</span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>

      {canCreate ? (
        adding ? (
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Client name"
              aria-label="New workspace name"
              className="border-border bg-surface min-w-0 flex-1 rounded-xl border px-3 py-3 text-sm"
            />
            <button
              type="button"
              onClick={() => void create()}
              disabled={busy || !name.trim()}
              className="bg-accent shrink-0 rounded-xl px-4 py-3 text-sm font-medium text-white disabled:opacity-40"
            >
              {busy ? 'Creating…' : 'Create'}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="text-ink-muted mt-2 text-xs underline"
          >
            + New workspace
          </button>
        )
      ) : null}

      {error ? (
        <p role="alert" className="text-hot mt-2 text-sm">
          {error}
        </p>
      ) : null}
    </section>
  );
}

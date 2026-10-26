'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { WorkflowPlanStepView, WorkflowView } from '../lib/api';
import { StatusChip, WorkflowPlan } from './workflow-plan';

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const error = json.error as { message?: string; details?: { errors?: string[] } } | undefined;
    const all = error?.details?.errors;
    throw new Error(
      all && all.length > 1
        ? all.join('\n')
        : (error?.message ?? `request failed (${response.status})`),
    );
  }
  return json;
}

function Button({
  children,
  onClick,
  busy,
  primary,
  danger,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  busy?: boolean;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || disabled}
      className={`min-h-[44px] rounded-xl px-4 text-sm font-medium disabled:opacity-50 ${
        primary
          ? 'bg-accent text-white'
          : danger
            ? 'border border-rose-500/40 text-rose-600'
            : 'border-border border'
      }`}
    >
      {busy ? '…' : children}
    </button>
  );
}

/**
 * Everything a person does to one workflow: publish, run, dry-run, pause,
 * resume, clone, export, archive and delete; change it in English; and edit
 * the step graph and schedule directly. Each control is one API call and a
 * refresh, so the page always shows what the server holds.
 */
export function WorkflowControls({ workflow }: { workflow: WorkflowView }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [instruction, setInstruction] = useState('');
  const [dryRun, setDryRun] = useState<DryRunView | null>(null);

  async function act(label: string, run: () => Promise<void>) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await run();
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const base = `/workflows/${encodeURIComponent(workflow.id)}`;
  const published = workflow.publishedVersion !== null;

  return (
    <div className="flex flex-col gap-6">
      <section aria-label="Workflow actions" className="flex flex-wrap gap-2">
        {workflow.unpublishedChanges ? (
          <Button
            primary
            busy={busy === 'publish'}
            onClick={() =>
              act('publish', async () => {
                await call('POST', `${base}/publish`);
                setNotice(`v${workflow.version} published and switched on.`);
              })
            }
          >
            Publish v{workflow.version}
          </Button>
        ) : null}
        <Button
          busy={busy === 'dry'}
          onClick={() =>
            act('dry', async () => {
              const result = (await call('POST', `${base}/dry-run`)) as { preview: DryRunView };
              setDryRun(result.preview);
            })
          }
        >
          Dry run
        </Button>
        {published ? (
          <Button
            busy={busy === 'run'}
            onClick={() =>
              act('run', async () => {
                const result = (await call('POST', `${base}/run`)) as { run: { runId: string } };
                router.push(`/workflows/${workflow.id}/runs/${result.run.runId}`);
              })
            }
          >
            Run now
          </Button>
        ) : null}
        {workflow.status === 'active' ? (
          <Button
            busy={busy === 'pause'}
            onClick={() => act('pause', () => call('POST', `${base}/pause`).then(() => {}))}
          >
            Pause
          </Button>
        ) : null}
        {workflow.status === 'paused' && published ? (
          <Button
            busy={busy === 'resume'}
            onClick={() => act('resume', () => call('POST', `${base}/resume`).then(() => {}))}
          >
            Resume
          </Button>
        ) : null}
        <Button
          busy={busy === 'clone'}
          onClick={() =>
            act('clone', async () => {
              const result = (await call('POST', `${base}/clone`)) as { workflow: { id: string } };
              router.push(`/workflows/${result.workflow.id}`);
            })
          }
        >
          Duplicate
        </Button>
        <a
          href={`/api/v1${base}/export`}
          download={`${workflow.id}.workflow.json`}
          className="border-border inline-flex min-h-[44px] items-center rounded-xl border px-4 text-sm font-medium"
        >
          Export
        </a>
        <Button
          busy={busy === 'archive'}
          onClick={() =>
            act('archive', async () => {
              await call('POST', `${base}/archive`);
              router.push('/workflows');
            })
          }
        >
          Archive
        </Button>
        <Button
          danger
          busy={busy === 'delete'}
          onClick={() => {
            if (
              !window.confirm(
                `Delete “${workflow.name}” and its run history? Its campaign is paused, not deleted.`,
              )
            )
              return;
            void act('delete', async () => {
              await call('DELETE', base);
              router.push('/workflows');
            });
          }}
        >
          Delete
        </Button>
      </section>

      {error ? (
        <p role="alert" className="text-sm whitespace-pre-line text-rose-600">
          {error}
        </p>
      ) : null}
      {notice ? <p className="text-sm text-emerald-600">{notice}</p> : null}

      {dryRun ? <DryRunPanel preview={dryRun} onClose={() => setDryRun(null)} /> : null}

      <section aria-labelledby="edit-english" className="flex flex-col gap-2">
        <h2 id="edit-english" className="text-sm font-semibold">
          Change it in English
        </h2>
        <textarea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          rows={3}
          maxLength={4000}
          placeholder="Make it 100 emails a day, add Canada, and drop the job boards."
          className="border-border bg-surface rounded-2xl border p-3 text-sm"
        />
        <div>
          <Button
            busy={busy === 'edit'}
            disabled={instruction.trim().length < 2}
            onClick={() =>
              act('edit', async () => {
                const result = (await call('PATCH', base, { instruction })) as {
                  workflow: { version: number };
                };
                setInstruction('');
                setNotice(
                  `Saved as v${result.workflow.version}. Publish it to make it the one that runs.`,
                );
              })
            }
          >
            Apply as a new version
          </Button>
        </div>
      </section>

      <StepEditor
        workflow={workflow}
        busy={busy === 'steps'}
        onSave={(definition, note) =>
          act('steps', async () => {
            const result = (await call('PATCH', base, { definition, note })) as {
              workflow: { version: number };
            };
            setNotice(
              `Saved as v${result.workflow.version}. Publish it to make it the one that runs.`,
            );
          })
        }
      />
    </div>
  );
}

// ------------------------------------------------------------ dry run

interface DryRunView {
  runId: string;
  transmitted: number;
  checks: { id: string; title: string; status: string; detail: string }[];
  estimate: {
    dailyLimit: number;
    effectiveDailyCap: number;
    sentToday: number;
    workspaceDailyCap: number;
  };
  policy: { decision: string; reason: string };
  decisions: { send: number; queueForApproval: number; noSend: number };
  jobs: {
    title: string | null;
    company: string | null;
    url: string;
    status: string;
    agency: boolean;
  }[];
  candidates: {
    personId: string;
    name: string;
    title: string | null;
    company: string | null;
    address: string | null;
    addressStatus: string;
    evidence: { summary: string; url: string | null }[];
    decision: string;
    reason: string;
  }[];
  plan: WorkflowPlanStepView[];
}

function DryRunPanel({ preview, onClose }: { preview: DryRunView; onClose: () => void }) {
  const statuses = Object.fromEntries(preview.checks.map((c) => [c.id, c]));
  return (
    <section
      aria-labelledby="dry-run-heading"
      className="border-accent/40 flex flex-col gap-4 rounded-2xl border p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="dry-run-heading" className="text-sm font-semibold">
            Dry run — nothing was sent
          </h2>
          <p className="text-ink-muted mt-1 text-xs tabular-nums">
            Up to {preview.estimate.effectiveDailyCap}/day (asked {preview.estimate.dailyLimit},
            workspace ceiling {preview.estimate.workspaceDailyCap}); {preview.estimate.sentToday}{' '}
            sent today. Policy engine: {preview.policy.decision.replace(/_/g, ' ')}.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-ink-muted min-h-[44px] px-2 text-xs"
        >
          Close
        </button>
      </div>

      <div className="grid grid-cols-3 gap-2 text-center tabular-nums">
        <Stat label="would send" value={preview.decisions.send} />
        <Stat label="for approval" value={preview.decisions.queueForApproval} />
        <Stat label="no send" value={preview.decisions.noSend} />
      </div>

      <div>
        <h3 className="mb-2 text-xs font-semibold tracking-wide uppercase">People and decisions</h3>
        {preview.candidates.length === 0 ? (
          <p className="text-ink-muted text-xs">
            Nobody in the campaign yet — the first run creates it and starts finding people.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {preview.candidates.map((c) => (
              <li key={c.personId} className="border-border rounded-xl border p-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">
                    {c.name}
                    {c.title ? <span className="text-ink-muted"> · {c.title}</span> : null}
                    {c.company ? <span className="text-ink-muted"> · {c.company}</span> : null}
                  </span>
                  <StatusChip status={c.decision} />
                </div>
                <p className="text-ink-muted mt-1">
                  {c.address ?? 'no address'} ({c.addressStatus}) — {c.reason}
                </p>
                {c.evidence.map((e) => (
                  <p key={e.summary} className="text-ink-muted mt-1">
                    Evidence:{' '}
                    {e.url ? (
                      <a
                        href={e.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-accent underline"
                      >
                        {e.summary}
                      </a>
                    ) : (
                      e.summary
                    )}
                  </p>
                ))}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h3 className="mb-2 text-xs font-semibold tracking-wide uppercase">Matched jobs</h3>
        {preview.jobs.length === 0 ? (
          <p className="text-ink-muted text-xs">None yet.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-xs">
            {preview.jobs.map((j) => (
              <li key={j.url}>
                <a href={j.url} target="_blank" rel="noreferrer" className="text-accent underline">
                  {j.title ?? 'Untitled posting'}
                </a>{' '}
                <span className="text-ink-muted">
                  {j.company ?? ''} · {j.status}
                  {j.agency ? ' · agency' : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h3 className="mb-2 text-xs font-semibold tracking-wide uppercase">Step checks</h3>
        <WorkflowPlan plan={preview.plan} statuses={statuses} />
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="border-border rounded-xl border p-2">
      <div className="text-lg font-semibold">{value}</div>
      <div className="text-ink-muted text-[11px]">{label}</div>
    </div>
  );
}

// ---------------------------------------------------------- step editor

const NODE_TYPES = [
  'discover_opportunities',
  'enrich',
  'verify_contact',
  'score_filter',
  'deduplicate',
  'draft',
  'approval',
  'send',
  'wait',
  'classify_reply',
  'branch',
  'log_crm',
  'notify',
] as const;

/** Inputs whose values come from a fixed list. */
const CHOICES: Record<string, readonly string[]> = {
  source: ['discover', 'job_posts', 'launches'],
  mode: ['review', 'autopilot'],
  on: ['positive_reply', 'run_failed', 'daily_summary', 'reply_label'],
  channel: ['email'],
};

/** Inputs the server holds fixed; shown, not editable. */
const LOCKED = new Set(['requireVerified', 'groundedOnly', 'includePriorSends', 'channel']);

type EditableNode = {
  id: string;
  type: string;
  label: string;
  after: string[];
  when?: string[];
  config: Record<string, unknown>;
};

/**
 * The graph, node by node: each step's inputs, what it follows and the reply
 * labels it handles; the schedule and its zone. Save validates on the server
 * (unknown actions, cycles, a send without verification, de-duplication and
 * approval in front of it) and stores a new version; nothing runs until it is
 * published.
 */
function StepEditor({
  workflow,
  busy,
  onSave,
}: {
  workflow: WorkflowView;
  busy: boolean;
  onSave: (definition: unknown, note: string) => void;
}) {
  const [nodes, setNodes] = useState<EditableNode[]>(() =>
    workflow.definition.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      label: n.label,
      after: [...n.after],
      ...(n.when ? { when: [...n.when] } : {}),
      config: { ...n.config },
    })),
  );
  const [schedule, setSchedule] = useState({ ...workflow.definition.schedule });
  const [goal, setGoal] = useState(workflow.definition.goal);
  const [note, setNote] = useState('');
  const [newType, setNewType] = useState<string>('notify');
  const [problems, setProblems] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);

  const definition = () => ({ version: 2, goal, schedule, nodes });

  function update(index: number, change: Partial<EditableNode>) {
    setNodes((current) => current.map((n, i) => (i === index ? { ...n, ...change } : n)));
  }

  function setConfig(index: number, key: string, value: unknown) {
    setNodes((current) =>
      current.map((n, i) => (i === index ? { ...n, config: { ...n.config, [key]: value } } : n)),
    );
  }

  async function validate() {
    setChecking(true);
    try {
      const result = (await call('POST', '/workflows/validate', { definition: definition() })) as {
        ok: boolean;
        errors?: string[];
        warnings?: string[];
      };
      setProblems(
        result.ok ? (result.warnings ?? []).map((w) => `note: ${w}`) : (result.errors ?? []),
      );
      if (result.ok && (result.warnings ?? []).length === 0) setProblems(['valid — ready to save']);
    } catch (e) {
      setProblems([(e as Error).message]);
    } finally {
      setChecking(false);
    }
  }

  return (
    <section aria-labelledby="steps-heading" className="flex flex-col gap-3">
      <h2 id="steps-heading" className="text-sm font-semibold">
        Steps and schedule
      </h2>

      <label className="text-ink-muted flex flex-col gap-1 text-xs">
        Goal
        <input
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          className="border-border bg-surface text-ink min-h-[44px] rounded-xl border px-3 text-sm"
        />
      </label>

      <fieldset className="border-border grid grid-cols-2 gap-2 rounded-2xl border p-3 text-xs sm:grid-cols-4">
        <legend className="px-1 font-medium">Trigger</legend>
        <label className="flex flex-col gap-1">
          When
          <select
            value={schedule.kind}
            onChange={(e) =>
              setSchedule({ ...schedule, kind: e.target.value as typeof schedule.kind })
            }
            className="border-border bg-surface min-h-[40px] rounded-lg border px-2"
          >
            <option value="hourly">Every hour</option>
            <option value="weekdays">Weekdays</option>
            <option value="daily">Every day</option>
            <option value="weekly">Weekly</option>
            <option value="event">On each reply</option>
            <option value="manual">Only by hand</option>
          </select>
        </label>
        {schedule.kind === 'weekly' ? (
          <label className="flex flex-col gap-1">
            Day
            <select
              value={schedule.weekday ?? 1}
              onChange={(e) => setSchedule({ ...schedule, weekday: Number(e.target.value) })}
              className="border-border bg-surface min-h-[40px] rounded-lg border px-2"
            >
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="flex flex-col gap-1">
          Time
          <input
            type="time"
            value={`${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`}
            onChange={(e) => {
              const [h, m] = e.target.value.split(':').map(Number);
              setSchedule({ ...schedule, hour: h ?? 0, minute: m ?? 0 });
            }}
            className="border-border bg-surface min-h-[40px] rounded-lg border px-2"
          />
        </label>
        <label className="col-span-2 flex flex-col gap-1">
          Time zone
          <input
            value={schedule.timezone}
            onChange={(e) => setSchedule({ ...schedule, timezone: e.target.value })}
            className="border-border bg-surface min-h-[40px] rounded-lg border px-2"
          />
        </label>
      </fieldset>

      <ol className="flex flex-col gap-2">
        {nodes.map((node, index) => (
          <li key={`${node.id}-${index}`}>
            <details className="border-border bg-surface-raised rounded-2xl border p-3">
              <summary className="flex cursor-pointer items-center justify-between gap-2 text-sm">
                <span>
                  <span className="font-medium">{node.label}</span>{' '}
                  <span className="text-ink-muted font-mono text-[11px]">
                    {node.id} · {node.type}
                  </span>
                </span>
              </summary>
              <div className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                <TextField
                  label="Label"
                  value={node.label}
                  onChange={(v) => update(index, { label: v })}
                />
                <TextField
                  label="Runs after (step ids)"
                  value={node.after.join(', ')}
                  onChange={(v) => update(index, { after: splitList(v) })}
                />
                {node.when !== undefined ||
                nodes.some((n) => n.type === 'branch' && node.after.includes(n.id)) ? (
                  <TextField
                    label="Only on reply labels"
                    value={(node.when ?? []).join(', ')}
                    onChange={(v) => {
                      const when = splitList(v);
                      setNodes((current) =>
                        current.map((n, i) => {
                          if (i !== index) return n;
                          const { when: _old, ...rest } = n;
                          return when.length ? { ...rest, when } : rest;
                        }),
                      );
                    }}
                  />
                ) : null}
                {Object.entries(node.config).map(([key, value]) => (
                  <ConfigField
                    key={key}
                    name={key}
                    value={value}
                    onChange={(v) => setConfig(index, key, v)}
                  />
                ))}
              </div>
              <button
                type="button"
                onClick={() => setNodes((current) => current.filter((_, i) => i !== index))}
                className="mt-3 min-h-[40px] text-xs text-rose-600"
              >
                Remove this step
              </button>
            </details>
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap items-end gap-2 text-xs">
        <label className="flex flex-col gap-1">
          Add a step
          <select
            value={newType}
            onChange={(e) => setNewType(e.target.value)}
            className="border-border bg-surface min-h-[44px] rounded-xl border px-2"
          >
            {NODE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => {
            let n = nodes.length + 1;
            while (nodes.some((x) => x.id === `${newType.split('_')[0]}-${n}`)) n += 1;
            const last = nodes.at(-1);
            setNodes([
              ...nodes,
              {
                id: `${newType.split('_')[0]}-${n}`,
                type: newType,
                label: newType.replace(/_/g, ' '),
                after: last && newType !== 'discover_opportunities' ? [last.id] : [],
                config:
                  newType === 'discover_opportunities' ? { source: 'discover', query: '' } : {},
              },
            ]);
          }}
          className="border-border min-h-[44px] rounded-xl border px-4 font-medium"
        >
          Add
        </button>
      </div>

      <TextField label="Version note (optional)" value={note} onChange={setNote} />

      {problems.length > 0 ? (
        <ul role="status" className="flex flex-col gap-1 text-xs">
          {problems.map((p) => (
            <li
              key={p}
              className={
                p.startsWith('valid')
                  ? 'text-emerald-600'
                  : p.startsWith('note')
                    ? 'text-amber-600'
                    : 'text-rose-600'
              }
            >
              {p}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button busy={checking} onClick={() => void validate()}>
          Validate
        </Button>
        <Button
          primary
          busy={busy}
          onClick={() => onSave(definition(), note.trim() || 'edited steps')}
        >
          Save as new version
        </Button>
      </div>
    </section>
  );
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function TextField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="text-ink-muted flex flex-col gap-1">
      {label}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="border-border bg-surface text-ink min-h-[40px] rounded-lg border px-2"
      />
    </label>
  );
}

/** One input per config value, by its shape: list, number, switch, choice or text. */
function ConfigField({
  name,
  value,
  onChange,
}: {
  name: string;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const label = name.replace(/([A-Z])/g, ' $1').toLowerCase();
  if (LOCKED.has(name)) {
    return (
      <p className="text-ink-muted">
        {label}: <strong>{String(value)}</strong> (fixed)
      </p>
    );
  }
  if (Array.isArray(value)) {
    return (
      <TextField
        label={`${label} (comma-separated)`}
        value={value.join(', ')}
        onChange={(v) => onChange(splitList(v))}
      />
    );
  }
  if (typeof value === 'boolean') {
    return (
      <label className="text-ink-muted flex min-h-[40px] items-center gap-2">
        <input
          type="checkbox"
          checked={value}
          onChange={(e) => onChange(e.target.checked)}
          className="size-4"
        />
        {label}
      </label>
    );
  }
  if (CHOICES[name]) {
    return (
      <label className="text-ink-muted flex flex-col gap-1">
        {label}
        <select
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          className="border-border bg-surface text-ink min-h-[40px] rounded-lg border px-2"
        >
          {CHOICES[name]!.map((c) => (
            <option key={c} value={c}>
              {c.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (typeof value === 'number' || value === null || /count|limit|days|words|per/i.test(name)) {
    return (
      <label className="text-ink-muted flex flex-col gap-1">
        {label}
        <input
          type="number"
          value={value === null || value === undefined ? '' : String(value)}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          className="border-border bg-surface text-ink min-h-[40px] rounded-lg border px-2"
        />
      </label>
    );
  }
  return <TextField label={label} value={String(value ?? '')} onChange={onChange} />;
}

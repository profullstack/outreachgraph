import { createDatabase } from '@outreachgraph/db';
const db = createDatabase({ url: 'file:/home/anthony/.claude/jobs/e4931a1b/tmp/smoke5.db' });
const q = async (label: string, sql: string): Promise<void> => {
  const r = await db.execute(sql);
  console.log(`\n--- ${label} ---`);
  for (const row of r.rows.slice(0, 6)) console.log(JSON.stringify(row));
};
await q('people', 'SELECT display_name, identity_confidence FROM people');
await q('identities', 'SELECT network, handle, confidence FROM social_identities');
await q('recommendations', 'SELECT action, network, status, priority FROM recommendations');
await q('drafts', 'SELECT substr(body,1,220) body FROM drafts');
await q('actions', 'SELECT kind, network, status, substr(error,1,160) error FROM actions');
await q('stage events', 'SELECT stage, COUNT(*) n FROM lead_stage_events GROUP BY stage');

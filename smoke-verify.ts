import { createDatabase } from '@outreachgraph/db';
const db = createDatabase({ url: 'file:/home/anthony/.claude/jobs/e4931a1b/tmp/smoke5.db' });
await db.execute("UPDATE users SET email_verified_at = datetime('now')");
const r = await db.execute('SELECT id, email, email_verified_at FROM users');
console.log(r.rows);

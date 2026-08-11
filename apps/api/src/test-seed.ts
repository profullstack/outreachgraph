/**
 * Test fixtures: a fully migrated database with one workspace, campaign,
 * person and pending recommendation.
 *
 * Shared by the API tests so each test starts from an identical, realistic
 * state rather than hand-rolling inserts.
 */

import { createDatabase, migrate, now, type Client } from '@outreachgraph/db';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const MIGRATIONS_DIR = join(import.meta.dir, '../../../migrations');

export const SEED = {
  organizationId: 'org_test',
  workspaceId: 'wsp_test',
  userId: 'usr_test',
  offeringId: 'off_test',
  campaignId: 'cmp_test',
  personId: 'per_jane',
  companyId: 'co_acme',
  signalId: 'sig_fees',
  recommendationId: 'rec_reply',
  draftId: 'drf_reply',
} as const;

export interface SeededDatabase {
  readonly db: Client;
  readonly cleanup: () => void;
}

export async function seedDatabase(label: string): Promise<SeededDatabase> {
  const path = join(import.meta.dir, `../.test-${label}-${process.pid}.db`);
  const db = createDatabase({ url: `file:${path}` });

  await migrate(db, MIGRATIONS_DIR);

  const stamp = now();

  await db.batch([
    {
      sql: `INSERT INTO organizations (id, name, slug, created_at, updated_at)
            VALUES (?, 'Test Org', 'test-org', ?, ?)`,
      args: [SEED.organizationId, stamp, stamp],
    },
    {
      sql: `INSERT INTO users (id, email, name, created_at, updated_at)
            VALUES (?, 'test@example.com', 'Test User', ?, ?)`,
      args: [SEED.userId, stamp, stamp],
    },
    {
      sql: `INSERT INTO workspaces (id, organization_id, name, slug, min_outreach_confidence,
            created_at, updated_at) VALUES (?, ?, 'Test', 'test', 0.85, ?, ?)`,
      args: [SEED.workspaceId, SEED.organizationId, stamp, stamp],
    },
    {
      sql: `INSERT INTO offerings (id, workspace_id, name, category, created_at, updated_at)
            VALUES (?, ?, 'ExamplePay', 'developer payments infrastructure', ?, ?)`,
      args: [SEED.offeringId, SEED.workspaceId, stamp, stamp],
    },
    {
      sql: `INSERT INTO campaigns (id, workspace_id, name, offering_id, approval_mode,
            budget_json, status, created_at, updated_at)
            VALUES (?, ?, 'Developer Payments', ?, 'draft_and_approve', ?, 'running', ?, ?)`,
      args: [
        SEED.campaignId,
        SEED.workspaceId,
        SEED.offeringId,
        JSON.stringify({ maxActionsPerDay: 50, maxActionsPerProspectPerWeek: 1 }),
        stamp,
        stamp,
      ],
    },
    {
      sql: `INSERT INTO companies (id, name, domain, employee_count, industry, created_at, updated_at)
            VALUES (?, 'Acme', 'acme.com', 120, 'SaaS', ?, ?)`,
      args: [SEED.companyId, stamp, stamp],
    },
    {
      sql: `INSERT INTO people (id, display_name, first_name, last_name, current_company_id,
            current_title, location, identity_confidence, status, outreach_eligible,
            believed_minor, created_at, updated_at)
            VALUES (?, 'Jane Smith', 'Jane', 'Smith', ?, 'VP Engineering',
            'San Francisco Bay Area', 0.97, 'active', 1, 0, ?, ?)`,
      args: [SEED.personId, SEED.companyId, stamp, stamp],
    },
    {
      sql: `INSERT INTO social_identities (id, person_id, network, handle, platform_user_id,
            confidence, source_type, verified_by, first_seen_at)
            VALUES ('sid_jane_x', ?, 'x', 'janesmith', 'x_1001', 0.97, 'official_api', '[]', ?)`,
      args: [SEED.personId, stamp],
    },
    {
      sql: `INSERT INTO signals (id, workspace_id, person_id, network, signal_type, summary,
            evidence, source_url, source_timestamp, observed_at, confidence, relevance, sentiment)
            VALUES (?, ?, ?, 'x', 'recommendation_request',
            'Asked for alternatives to a competitor for cross-border payouts',
            'Does anyone have a good alternative to...', 'https://x.com/janesmith/status/1',
            ?, ?, 0.94, 0.91, 'negative')`,
      args: [SEED.signalId, SEED.workspaceId, SEED.personId, stamp, stamp],
    },
    {
      sql: `INSERT INTO scores (id, campaign_id, person_id, workspace_id, icp_fit,
            identity_confidence, intent, reachability, relationship, opportunity,
            weights_json, computed_at)
            VALUES ('scr_jane', ?, ?, ?, 96, 97, 94, 80, 10, 92, '{}', ?)`,
      args: [SEED.campaignId, SEED.personId, SEED.workspaceId, stamp],
    },
    {
      sql: `INSERT INTO recommendations (id, workspace_id, campaign_id, person_id, action,
            network, priority, reason, trigger_signal_id, policy_status, policy_version,
            expected_goal, status, created_at)
            VALUES (?, ?, ?, ?, 'reply', 'x', 92,
            'Prospect asked for alternatives to a competitor 4 hours ago.',
            ?, 'allow_with_approval', '2026-08-11', 'start_conversation', 'pending', ?)`,
      args: [
        SEED.recommendationId,
        SEED.workspaceId,
        SEED.campaignId,
        SEED.personId,
        SEED.signalId,
        stamp,
      ],
    },
    {
      sql: `INSERT INTO drafts (id, workspace_id, recommendation_id, body, grounded_signal_ids,
            checks_json, created_at, updated_at)
            VALUES (?, ?, ?, 'We ran into a similar cross-border settlement issue...', ?, '[]', ?, ?)`,
      args: [
        SEED.draftId,
        SEED.workspaceId,
        SEED.recommendationId,
        JSON.stringify([SEED.signalId]),
        stamp,
        stamp,
      ],
    },
    {
      sql: `INSERT INTO integrations (id, workspace_id, kind, network, status, created_at, updated_at)
            VALUES ('int_x', ?, 'social', 'x', 'connected', ?, ?)`,
      args: [SEED.workspaceId, stamp, stamp],
    },
    {
      sql: `INSERT INTO integration_accounts (id, integration_id, workspace_id, network, status,
            scopes, created_at, updated_at)
            VALUES ('iac_x', 'int_x', ?, 'x', 'active', '[]', ?, ?)`,
      args: [SEED.workspaceId, stamp, stamp],
    },
  ]);

  return {
    db,
    cleanup: () => {
      db.close();
      for (const suffix of ['', '-wal', '-shm']) {
        rmSync(`${path}${suffix}`, { force: true });
      }
    },
  };
}

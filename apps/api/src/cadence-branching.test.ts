/**
 * Branching plans over HTTP: a step's condition and acceptance window go in
 * through `POST /cadences` and come back out of `GET /cadences/:id`, and a
 * malformed one is refused with the domain's own sentence.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { createApp } from './app';
import type { RequestActor } from './context';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';

const ACTOR: RequestActor = {
  userId: SEED.userId,
  workspaceId: SEED.workspaceId,
  organizationId: SEED.organizationId,
  role: 'owner',
};

let active: SeededDatabase | undefined;
afterEach(() => {
  active?.cleanup();
  active = undefined;
});

async function app(label: string) {
  active = await seedDatabase(label);
  return createApp({ db: active.db, authenticate: async () => ACTOR });
}

function post(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

describe('cadences with conditions', () => {
  test('are stored and returned', async () => {
    const api = await app('api-branching');

    const created = await api.request(
      '/api/v1/cadences',
      post({
        name: 'Visit, invite, then DM or email',
        steps: [
          { network: 'linkedin', action: 'view_profile', delayHours: 0 },
          { network: 'linkedin', action: 'connect', delayHours: 24, waitForAcceptanceHours: 168 },
          { network: 'linkedin', action: 'send_dm', delayHours: 0, condition: 'if_connected' },
          { network: 'email', action: 'send_email', delayHours: 0, condition: 'if_not_connected' },
        ],
      }),
    );
    expect(created.status).toBe(201);
    const { cadenceId } = (await created.json()) as { cadenceId: string };

    const detail = (await (await api.request(`/api/v1/cadences/${cadenceId}`)).json()) as {
      steps: Array<{ condition: string; wait_for_acceptance_hours: number | null }>;
    };
    expect(detail.steps.map((s) => s.condition)).toEqual([
      'always',
      'always',
      'if_connected',
      'if_not_connected',
    ]);
    expect(detail.steps[1]?.wait_for_acceptance_hours).toBe(168);
  });

  test('a bad condition is refused with a sentence', async () => {
    const api = await app('api-branching-bad');

    const response = await api.request(
      '/api/v1/cadences',
      post({
        name: 'Broken',
        steps: [
          { network: 'bluesky', action: 'reply' },
          { network: 'email', action: 'send_email', condition: 'if_clicked' },
        ],
      }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { details: { steps: string[] } } };
    expect(body.error.details.steps).toContain(
      'A click can only follow an email we sent, and no step before this one sends an email.',
    );
  });
});

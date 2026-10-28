# Webhooks, Slack and CRM sync

PRD §28. Where a workspace's events go once they leave the product.

## Events

| Type                      | Emitted from                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------- |
| `reply.received`          | `receiveReplies` (IMAP polling) and `POST /people/:id/replied`                      |
| `link.clicked`            | `recordLinkClick`, human clicks only (scanners and prefetches are not announced)    |
| `prospect.created`        | `recordDiscovered`, when a person joins a campaign                                  |
| `recommendation.approved` | `approveRecommendation` (not the internal auto-approval of research cards)          |
| `action.sent`             | `recordEmailSent`, `recordBlueskySent` (Bluesky, X, LinkedIn), manual execute route |
| `cadence.completed`       | the cadence engine, when a plan runs out of steps (not when a reply stops it)       |
| `person.suppressed`       | unsubscribe links, the `suppress` rule action, `POST /suppressions` (person keys)   |
| `ping`                    | `POST /webhooks/:id/test`, to that endpoint only                                    |

Every emit goes through `emitWebhookEvent(db, workspaceId, type, data)` in
`packages/pipeline/src/webhooks.ts`. It never sends and never throws: it hands the
event to the fleet webhook hub, [`@profullstack/webhooks`](https://github.com/profullstack/webhooks),
which writes a `webhook_deliveries` row per matching endpoint, and it queues a
`sync_crm` job per connected CRM for `reply.received` and `recommendation.approved`.
The hub keeps its outbox in this app's own tables through an adapter
(`packages/pipeline/src/webhook-store.ts`), and apps/server starts its drainer once
at boot.

## The envelope

A [CloudEvents 1.0](https://cloudevents.io/) object that also keeps every field of the
original envelope (`id`, `type`, `createdAt`, `workspaceId`, `data`), so receivers
written before 0.24.0 keep working unchanged:

```json
{
  "specversion": "1.0",
  "id": "evt_…",
  "type": "reply.received",
  "source": "https://outreachgraph.com",
  "subject": "person:per_…",
  "time": "2026-09-24T12:00:00.000Z",
  "datacontenttype": "application/json",
  "data": {
    "personId": "per_…",
    "subject": "Re: pricing",
    "person": {
      "id": "per_…",
      "name": "Jane Smith",
      "title": "CTO",
      "company": "Acme",
      "email": "jane@acme.com"
    }
  },
  "createdAt": "2026-09-24T12:00:00.000Z",
  "workspaceId": "wsp_…"
}
```

`id` is the same on every retry of a delivery; dedupe on it. `data` fields are
additive: new ones may appear, existing ones never change meaning.

## Verifying a delivery

Every delivery carries two independent signatures; check either one.

**Standard Webhooks** (`webhook-id`, `webhook-timestamp`, `webhook-signature`, plus
`webhook-event`): `webhook-signature` is `v1,` and the base64 HMAC-SHA256 of
`${webhook-id}.${webhook-timestamp}.${raw body}`, keyed with the base64-decoded part
of the secret after `whsec_`. Any Standard Webhooks library verifies it, as does
`verifySignature` from `@profullstack/webhooks`. Dedupe on `webhook-id`.

**The original header**, kept unchanged for existing receivers:
`X-OutreachGraph-Signature: t=<unix seconds>,v1=<hex>`, with `X-OutreachGraph-Event`
and `X-OutreachGraph-Delivery` (the event id). `v1` is
`HMAC-SHA256(secret, "<t>.<raw request body>")` as lowercase hex, keyed with the
whole secret string (`whsec_…` included) as UTF-8, the same scheme as Stripe.
Compute it over the raw bytes, compare in constant time, and reject a `t` more than
five minutes from now. `verifyWebhookSignature` in
`packages/providers/src/webhooks/sign.ts` is a reference implementation.

Bodies are sent as `content-type: application/json`.

The secret (`whsec_…`) is returned once, when the endpoint is created, and again
only by rotating it (`POST /api/v1/webhooks/:id/rotate`), which stops the old one
at once.

## Delivery

- Answer any 2xx within 10 seconds. Anything else is retried by the hub after
  30 s, 2 min, 10 min, 1 h, 6 h, 24 h and 48 h (8 attempts over about three days).
  Retries survive a restart: the outbox is the `webhook_deliveries` table.
- 20 failed deliveries in a row switch the endpoint off; the reason shows on the
  list. Turning it back on (`PATCH /api/v1/webhooks/:id` `{"enabled": true}`)
  clears the count.
- `410 Gone` disables the endpoint at once.
- Redirects are not followed.
- The URL must be `https` and must resolve only to public addresses. This is
  checked when the endpoint is created and again before every attempt
  (`packages/providers/src/net/public-url.ts`).
- The delivery log (`GET /api/v1/webhooks/:id/deliveries`) keeps a month.

## Slack

Add the endpoint with `kind: "slack"` and an incoming-webhook URL
(`https://hooks.slack.com/services/…`). Each event becomes one short line
(`formatSlackMessage`) instead of the JSON envelope.

## Zapier, Make, n8n

No dedicated integration is needed: each has a "catch hook" or webhook trigger
that gives you an https URL. Add it as a generic endpoint, subscribe to the
events you want, and branch on `type` in the zap or scenario. Signature
checking is optional there but available (n8n and Make can both compute an
HMAC).

## CRMs

`PUT /api/v1/integrations/crm/hubspot|pipedrive` with `{ "token": "…" }`, or
`og connect hubspot|pipedrive`. The token is verified against the CRM, then
stored encrypted like every other integration credential.

On `reply.received` and on approval of outbound outreach, the person is found by
their personal email address (created if missing, never overwritten) and a note
is added. People with no personal address are skipped. A refused token marks the
connection revoked so later events stop trying; the status route shows the last
sync time and error.

- HubSpot: a private app token with `crm.objects.contacts.read` and
  `crm.objects.contacts.write`.
- Pipedrive: a personal API token, sent in the `x-api-token` header.

## Surfaces

- API: `GET/POST /api/v1/webhooks`, `GET/PATCH/DELETE /api/v1/webhooks/:id`,
  `POST /api/v1/webhooks/:id/test` (sends now, returns the outcome),
  `POST /api/v1/webhooks/:id/rotate`, `POST /api/v1/webhooks/deliveries/:id/retry`, `GET /api/v1/webhooks/deliveries`,
  `GET /api/v1/webhooks/:id/deliveries`, `GET /api/v1/integrations/crm`,
  `PUT|DELETE /api/v1/integrations/crm/:provider`. Owner, admin and member only.
- CLI: `og webhooks list|add|rm|test|rotate|deliveries`, `og connect hubspot|pipedrive`,
  `og disconnect hubspot|pipedrive`.
- MCP: `list_webhooks`, `add_webhook`, `test_webhook`, `rotate_webhook_secret`,
  `remove_webhook`, `list_webhook_deliveries`.
- Web: Settings, below the notification settings.

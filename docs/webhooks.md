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
`packages/pipeline/src/webhooks.ts`. It never sends and never throws: it writes a
`webhook_deliveries` row and queues a `deliver_webhook` job per matching endpoint,
and a `sync_crm` job per connected CRM for `reply.received` and
`recommendation.approved`.

## The envelope

```json
{
  "id": "evt_…",
  "type": "reply.received",
  "createdAt": "2026-09-24T12:00:00.000Z",
  "workspaceId": "wsp_…",
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
  }
}
```

`id` is the same on every retry of a delivery; dedupe on it. `data` fields are
additive: new ones may appear, existing ones never change meaning.

## Verifying a delivery

Headers: `X-OutreachGraph-Signature: t=<unix seconds>,v1=<hex>`,
`X-OutreachGraph-Event`, `X-OutreachGraph-Delivery`.

`v1` is `HMAC-SHA256(secret, "<t>.<raw request body>")` as lowercase hex, the
same scheme as Stripe. Compute it over the raw bytes, compare in constant time,
and reject a `t` more than five minutes from now. `verifyWebhookSignature` in
`packages/providers/src/webhooks/sign.ts` is a reference implementation.

The secret (`whsec_…`) is returned once, when the endpoint is created. Lose it
and you delete the endpoint and add a new one.

## Delivery

- Answer any 2xx within 10 seconds. Anything else is retried by the job queue
  with doubling backoff from 30 seconds, 8 attempts in all (about an hour).
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

- API: `GET/POST /api/v1/webhooks`, `DELETE /api/v1/webhooks/:id`,
  `POST /api/v1/webhooks/:id/test`, `GET /api/v1/webhooks/deliveries`,
  `GET /api/v1/webhooks/:id/deliveries`, `GET /api/v1/integrations/crm`,
  `PUT|DELETE /api/v1/integrations/crm/:provider`. Owner, admin and member only.
- CLI: `og webhooks list|add|rm|test|deliveries`, `og connect hubspot|pipedrive`,
  `og disconnect hubspot|pipedrive`.
- MCP: `list_webhooks`, `add_webhook`.
- Web: Settings, below the notification settings.

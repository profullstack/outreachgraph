# OutreachGraph V1 Product Requirements

## 1. Product

OutreachGraph helps a workspace find and understand prospective customers,
prepare relevant outreach grounded in evidence, and manage the resulting
conversations. It is an evidence graph and an execution workflow, not a bulk
list sender. A person should be able to see why a prospect was selected, what
supports each personalised claim, what policy permits, and what happened next.

### 1.1 Product and technical principles

- Keep one Bun workspace and one deployable repository. Shared contracts live
  in packages; HTTP routes live under `/api/v1`.
- Keep `packages/domain` pure. Database access goes through `packages/db`.
  Migrations are forward-only and exist in both SQLite and Postgres forms.
- The web app is mobile-first and reads product data only through `/api/v1`.
  API requests use `cache: 'no-store'`; the service worker never caches API
  responses.
- The product remains usable with fixture providers and no external API keys.

## 7. Campaign setup

A campaign starts from a company website or a description of a market. The
workspace can select which configured product it sells, and campaign setup
queues discovery work without making the user wait for it. A campaign may be
paused, resumed, or archived. The guided multi-step campaign wizard and an ICP
agent remain future work.

Unattended sending is opt-in. New campaigns start in `draft_and_approve` mode.
Selecting autopilot is an explicit owner action and never bypasses policy.

## 8. Prospect pipeline

The pipeline discovers companies and people, resolves identity, enriches
contact details, screens against workspace rules, scores fit, and creates
recommendations. Every stage records enough source and status information to
explain its outcome. A provider result is never invented to fill a gap.

## 9. Identity and evidence

People, companies, accounts, signals, and relationships form an evidence graph.
Every source retains provenance and timestamps. Identity merges require
corroborating evidence; name plus city alone is insufficient. Personalised
claims must be supported by stored, available evidence.

## 10. Providers

Provider objects remain behind adapters in `packages/providers`. Discovery and
enrichment may use configured providers or fixtures. Sources must respect
their access terms; prohibited scraping and sensitive-category targeting are
out of scope.

## 11. Signals and 12. Scoring

Signals are typed, sourced, timestamped, and decayed over time. Prospect and
campaign scores use deterministic, inspectable inputs. Sensitive categories
are never scoring or targeting inputs.

## 13. Recommendations and cadences

Recommendations explain the proposed action and its evidence. Cadences are
ordered, conditional steps with delays and optional message variants. A reply,
opt-out, or bounce ends follow-up for that person. A/B reporting counts people
and replies; opens are an unreliable upper bound.

## 14. Content

The composer may use a language model to draft, but policy decisions remain
deterministic. Drafts are editable. Quality checks reject unsupported claims,
unsafe content, and messages that fail the product's grounding rules.

## 15. Approval queue

Human review is the default for outbound actions. The approval queue lets a
person inspect and edit a draft before approving it. An approval or execution
request is not trusted as a saved policy result; the live policy engine decides
again when the action is executed.

## 16. Platform policy

The deterministic Policy Engine is the authority for whether an action may be
executed. Unknown network/action pairs fail closed. Policy is re-evaluated from
current workspace, person, campaign, suppression, account, and rate-limit state
at execution time. Autopilot requires explicit campaign opt-in and a capability
that the capability matrix permits.

LinkedIn actions use only the member's own session after explicit risk
acceptance; otherwise the product hands the action to the member. GitHub is a
signal source, never an outreach channel.

## 17. Compliance and 18. Limits

Suppression survives deletion through a minimal tombstone. Opt-outs and known
bounces prevent future outreach. Address verification, rate limits, sender
health, company limits, and campaign budgets are enforced at the execution
boundary. Minors and sensitive categories are not targeted.

## 20. Assistants

Models may propose research, classifications, and copy. Deterministic code
validates proposals and selects only actions allowed by policy. A model never
decides whether an action is permitted.

## 21. Storage and 22. Person model

The schema stores workspaces, offerings, campaigns, people, companies,
evidence, signals, recommendations, drafts, actions, interactions, suppression,
and audit history. Application code uses `packages/db`; production uses
Postgres and development/tests may use SQLite.

## 23. API and 24. Shared clients

The authenticated REST API under `/api/v1` is the product data boundary. The
web app, CLI, MCP server, and integrations use the same API and shared request
contracts where they expose the same capability. Workspace ownership is
checked on every resource operation.

## 25. Product interface

The mobile-first interface covers prospect research, recommendations,
products/campaigns, results, follow-ups, inbox, and account setup. Product
pages use fresh API data and keep controls close to the work they affect.

### 25.4 Campaign performance review

For an active campaign with at least 50 emails sent in the last 30 days and a
reply rate below 2%, the product may show a review suggestion grounded in those
counts and the fresh-list benchmark. The suggestion may offer to pause the
campaign, but only an explicit human action changes campaign state. A dismissed
suggestion is hidden for the current page only and has no effect on delivery.
The review signal never sends, edits, or launches outreach.

## 27. Conversations

Email replies are collected into a unified inbox and labelled for triage.
Stop requests suppress further outreach. Suggested replies remain drafts for
human review unless the workspace separately enables an eligible reply mode.
CRM stages and notes may be synchronized with supported providers.

## 28. Integrations

Webhooks are signed. CRM sync is workspace-scoped. API keys and connected
provider credentials are stored through the secret-management boundary and do
not appear in logs or client bundles.

## 30. Usage

Usage events are recorded against a workspace. Billing enforcement and payment
provider changes are outside the product slice defined here.

## 34. Workspace isolation

Every person, campaign, recommendation, credential, and integration query is
scoped to the authenticated workspace. Cross-workspace access fails closed.
The one exception is a member's own intro card (§38), which carries only what
that member wrote and switched on.

## 36. Administration and 37. Feature flags

Administrative capabilities require explicit roles. Feature flags may disable
capabilities, but cannot widen the Policy Engine's allowed action set.

## 38. Introductions

Two account holders may be introduced to each other when both ask. This is the
opposite of outreach and shares none of its data: no prospect, signal, score,
provider record, or campaign is read to make or rank an introduction.

- **Opt-in card.** A member writes an intro card: a display name, a headline,
  who they want to meet, what they can offer, and topics. The card is closed
  until the member opens it, and opening requires a verified account email and
  a name, an ask, and an offer. Closing removes the member from the pool.
- **Matching is deterministic.** A member with an open card sees other open
  cards ranked by word overlap between each side's ask and the other's offer
  and topics. No model takes part, and each match carries the words that
  produced it. Only text the two members wrote on their cards is an input, so
  sensitive categories (§17) cannot enter through a derived signal.
- **Double opt-in.** Asking is the first consent; the other member accepting is
  the second. A match or a pending request shows a card and never an address
  or a user id. Only an accepted request shows each member the other's account
  email. Acceptance re-reads current state: a requester who has since closed
  their card cannot be accepted.
- **Refusal is final and quiet.** A decline blocks the pair in both directions.
  The requester is not told: the request reads as unanswered until it expires
  after 14 days, and the card reads as unavailable. The audit log keeps the
  real reason.
- **Limits.** One live request per pair, five requests per member per rolling
  day (withdrawn requests count), and a note is required with every request.
- **Nothing is sent.** This slice creates no email and no message on any
  network. Members read requests through the API and the MCP tools.
- **Prospects are never in the pool.** A person found by the pipeline, a public
  OpenProfile, or a directory record is not a member and cannot be matched,
  requested, or invited through this feature. Inviting people to join is
  outreach and stays under §15–§18.

## 39. CRM and booking page

A small CRM that people and agents can both drive, and a public booking page
that replaces Calendly. Every booked call is a PairUX video call.

- **Deals, not people.** A deal is one relationship the workspace is working:
  title, contact name/email/company, stage (`lead`, `contacted`, `replied`,
  `meeting`, `proposal`, `won`, `lost`), value, next step. It may link a
  `people` row but does not need one: a guest who booked a call has not cleared
  the identity bar of §8, so no people row is ever created from a booking.
- **Timeline.** Notes, call notes (with duration), meetings and emails are
  logged against a deal; a stage change writes its own entry. Reminders are
  dated to-dos, mailed once to their assignee when due.
- **Booking page.** One public page per member at `/calendar/<handle>`
  (`/schedule/<handle>` redirects to it): length, weekly hours in the page's
  zone, minimum notice, how far ahead, buffer. Slot math is Intl-only and the
  slot is re-checked at booking time; a partial unique index stops two guests
  taking one slot.
- **PairUX.** Each booking gets its own anonymous end-to-end-encrypted room
  link, `pairux.com/r/<room>#k=<key>`, made locally. Nothing is registered
  with PairUX and the key never reaches a server.
- **Into the CRM.** A booking finds the guest's deal by email (or makes one at
  `meeting`), logs the meeting, and sets a "write call notes" reminder for when
  the call ends. Cancelling removes that reminder.
- **Mail.** Confirmation to both sides (the guest's with a calendar file link,
  a manage link and the cross-promo block), an hour-before reminder to both,
  cancellation notices. Nothing else: the booking page is not outreach, and a
  guest is never enrolled in a campaign by booking.
- **Guest access.** The manage link carries a random token; only its SHA-256
  is stored. Public reads are throttled per address, bookings at 10 an hour.

## Explicit non-goals

- Sending a message to a prospect without approval as part of this task.
- Scraping prohibited sources, inventing contacts/provider results, or
  targeting sensitive categories.
- Changing pricing, billing terms, provider purchases, or unrelated repos.

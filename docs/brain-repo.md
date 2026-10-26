# Brain repo: a product's knowledge as markdown in git

OutreachGraph already knows what each product is, who buys it, how it should sound and what
prospects push back on. A brain repo puts that knowledge in plain markdown files in a private git
repository, so:

- every change is versioned and reviewed like code,
- rollback is one `git revert`,
- the files are vendor neutral: any AI tool your team uses can read them,
- every teammate's AI reads the same positioning and voice.

myna reads the same layout, so one brain serves both tools.

## Layout

```
<brain>/
  README.md                 optional, for people
  knowledge/
    positioning.md          what it is, who it is for, why it is different
    voice.md                brand voice
    audience.md             ICP
    objections.md           what prospects push back on or ask
  skills/                   myna skills (OutreachGraph ignores this)
```

A brain for several products puts each one in its own directory: `knowledge/<product-slug>/positioning.md`
and so on. A single-product brain uses `knowledge/*.md` directly.

Every knowledge file is YAML frontmatter (plain `key: value` scalars, and lists as `key: [a, b]`
or `- item` lines) followed by a markdown body with `## Section` headings.

### positioning.md

```markdown
---
product: ExamplePay
url: https://examplepay.dev
category: developer payments
source: outreachgraph
offering_id: off_123
exported_at: '2026-10-26T12:00:00.000Z'
---

# ExamplePay

Cross-border payouts for platforms.

## Value propositions

- Settles in 24 hours

## Problems it solves

- Wires take a week

## Competitors

- Wise
```

The paragraph under the title is the description. Imported back: name, category, url, description,
value propositions, problems it solves and competitors.

### voice.md

```markdown
---
name: ExamplePay
style: direct, specific, no hype
max_words: 120
---

# Voice: ExamplePay

## Instructions

Lead with the problem. No exclamation marks.

## Samples

> Saw your post about payouts taking a week. We fixed that for a platform your size.

> A second sample, as its own blockquote.

## Never claim

- guaranteed delivery
```

Each sample is a blockquote paragraph, or a `### Sample n` subsection if you prefer. Imported back:
style, max_words, instructions, samples and the claims never to make. Drafts use all of them.

### audience.md (export only)

The targeting of every campaign that sells the product, merged: `## Titles`, `## Seniorities`,
`## Industries`, `## Countries`, `## Technologies`, `## Keywords`, and `## Exclusions` when there
are any.

### objections.md (export only)

What prospects actually said, mined from inbound replies to the product's campaigns that the inbox
classified as not interested, a question or a referral. Grouped by label with counts and the date
window. Each line is the classifier's reason plus the first sentence of the reply (at most 160
characters) with greetings, quoted threads, names, company names, emails, phone numbers and links
removed. No model call: the same replies always give the same file.

## Workflow

Set it up once:

```sh
mkdir brain && cd brain && git init
og brain list                                # product ids, with a suggested slug
og brain export off_123                      # writes knowledge/*.md
git add -A && git commit -m "Brain: first export"
gh repo create my-team/brain --private --source . --push
```

Several products in one brain:

```sh
og brain export off_123 --slug examplepay
og brain export off_456 --slug otherthing
```

Day to day:

1. Teammates `git pull` and point their AI tools at `knowledge/`.
2. Someone edits `positioning.md` or `voice.md`, opens a pull request, and the team reviews the
   change like any other.
3. After merge, push it into OutreachGraph: `og brain import off_123` (add `--slug` for a
   multi-product brain). Only fields present in the files change.
4. Refresh the export now and then to pick up new objections: `og brain export off_123`, review the
   diff, commit.

`og brain export` never overwrites a file you changed by hand without keeping it: the previous copy
is saved next to it as `voice.bak-001.md` (then `-002`, and so on). Commit or delete those as you
see fit; `og brain import` ignores them. `og brain show off_123` prints the files without writing
anything.

## API and MCP

- `GET /api/v1/products/:id/brain?slug=` returns `{offeringId, files: {path: markdown}}`.
- `PUT /api/v1/products/:id/brain` with `{files, slug?}` imports positioning and voice and answers
  with the fields that changed. Lists follow the same limits as product setup (20 entries each).
- MCP: `get_product_brain` and `set_product_brain`.

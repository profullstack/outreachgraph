# Job posts

A company advertising a senior engineering role has said, in public, that it needs engineering
done and has budget for it. Job posts turn a list of postings into the real people behind them,
so they can be offered agentic work instead of (or before) a hire.

## Flow

1. **Collect.** Paste posting URLs, or search the job boards by keyword. A keyword is what you
   would type into a board: `senior software engineer (remote)` searches for the quoted title
   with `remote` as a loose qualifier. One ValueSERP query per board, because ValueSERP ignores
   `site:a OR site:b`.
2. **Resolve.** Each posting is read from its board's keyless JSON API (Workable, Greenhouse,
   Lever, Ashby; any other page by its title and meta tags). Then one ValueSERP search,
   `site:linkedin.com/in "<Company>" (founder OR CEO OR CTO OR …)`, finds people. A result is
   kept only when it names the company as itself: "Raydar Studios" and "Raydar & Associates"
   are other companies.
3. **Verify.** The company's own site (`/`, `/company`, `/about`, `/team`, `/contact`, plus
   about/team pages from its sitemap) is read for two things: addresses at its domain, attached
   to the person whose name they are (`david@raydar.xyz` to David Phillips), and names. A person
   the site names is marked `onCompanySite`. Once the site names anyone, a result whose own
   headline does not claim the company sinks: that is how a namesake company is told apart.
4. **Promote.** A contact joins a campaign through `intakeSocialPeople`, like any other
   stranger, with their employer's domain set (so `find_email` can work) and any published
   address. Nothing is sent; approval is unchanged. A posting saved with a campaign promotes its
   best contact (score ≥ 0.6) automatically.

Agency postings ("recruiting for this role on behalf of our client") are flagged: the founder and
recruiters rank first there, engineering leaders first for a direct employer.

## Surfaces

- API: `/api/v1/job-posts` — `GET`, `POST {url|urls, campaignId?}`, `POST /search {keyword,
boards?, limit?, campaignId?}`, `GET|PATCH|DELETE /:id`, `POST /:id/resolve`,
  `POST /:id/contacts/:contactId/promote {campaignId?}`. Writes are approver-only.
- CLI: `og jobs list | search "<keyword>" | add <url…> | show <id> | resolve <id> | promote <id>
<contactId> | status <id> <status> | note <id> <text> | rm <id>`.
- MCP: `list_job_posts`, `search_job_posts`, `add_job_posts`, `find_job_post_contacts`,
  `promote_job_post_contact`, `update_job_post`.
- Web: `/jobs` (linked from Products).
- Worker: `resolve_job_post`, queued when a posting is saved.

## Configuration

`VALUESERP_API_KEY` (the same key lead photos use). Without it postings can still be pasted and
read, keyword search is refused with that reason, and nobody is searched for. Cost: a keyword
search is one credit per board; resolving a posting is one credit, two when the board did not
say what the company's website is.

Migration `0046_job_posts`.

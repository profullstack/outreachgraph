<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## OutreachGraph web app

Next.js 16 App Router, React 19, Tailwind v4 (CSS-first — there is no
`tailwind.config.js`; tokens live in `@theme` blocks in `app/globals.css`).

- Mobile-first. Every flow must work at phone width before desktop styling is added.
- The app never queries Turso. All data comes from `/api/v1` via `lib/api.ts`.
- `cache: 'no-store'` on every API call, and the service worker refuses to cache `/api`. Approval state and policy decisions must never be stale.
- `public/sw.js` is hand-written, not generated. Navigations are network-first with the pre-cached `/offline` fallback; static assets are cache-first.
- Keep `viewportFit: 'cover'` plus `env(safe-area-inset-*)` padding — the bottom nav sits above the home indicator.

See the repository root `CLAUDE.md` for the non-negotiables that apply everywhere.

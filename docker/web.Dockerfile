# syntax=docker/dockerfile:1
#
# Next.js PWA (PRD §1.1).
#
# Uses Next's `output: 'standalone'` tracing, so the runtime stage copies only
# the traced server plus static assets rather than the whole node_modules tree.

FROM oven/bun:1.3.14-slim AS deps
WORKDIR /app

COPY package.json bun.lock ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY apps/worker/package.json ./apps/worker/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/db/package.json ./packages/db/
COPY packages/domain/package.json ./packages/domain/
COPY packages/identity/package.json ./packages/identity/
COPY packages/policy/package.json ./packages/policy/
COPY packages/providers/package.json ./packages/providers/
COPY packages/scoring/package.json ./packages/scoring/
COPY packages/signals/package.json ./packages/signals/

RUN bun install --frozen-lockfile

FROM oven/bun:1.3.14-slim AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web

ENV NEXT_TELEMETRY_DISABLED=1
RUN cd apps/web && bun run build

FROM oven/bun:1.3.14-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

# The standalone bundle carries its own minimal node_modules.
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public

RUN chown -R bun:bun /app
USER bun

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:3000/offline'); process.exit(r.ok ? 0 : 1)"

CMD ["bun", "apps/web/server.js"]

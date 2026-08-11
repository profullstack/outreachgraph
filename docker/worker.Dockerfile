# syntax=docker/dockerfile:1
#
# Background worker (PRD §1.1 principle 7).
#
# Same image shape as the API; only the entry point differs. Kept as a separate
# Dockerfile rather than a runtime flag so Railway can scale and restart the
# worker independently of request traffic.

FROM oven/bun:1.3.14-slim AS deps
WORKDIR /app

COPY package.json bun.lock ./
COPY apps/api/package.json ./apps/api/
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

FROM oven/bun:1.3.14-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.base.json tsconfig.json ./
COPY migrations ./migrations
COPY packages ./packages
COPY apps/worker ./apps/worker

RUN chown -R bun:bun /app
USER bun

EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:8081/health/live'); process.exit(r.ok ? 0 : 1)"

CMD ["bun", "apps/worker/src/index.ts"]

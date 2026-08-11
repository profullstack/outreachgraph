# syntax=docker/dockerfile:1
#
# API service (PRD §1.1 "Docker Requirements").
#
# Multi-stage: dependencies resolve in a layer that only changes when a
# manifest or the lockfile changes, so an ordinary source edit rebuilds only
# the final layer.

FROM oven/bun:1.3.14-slim AS deps
WORKDIR /app

# Manifests first — this layer is the expensive one to rebuild.
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
COPY apps/api ./apps/api

# The bun image ships a non-root `bun` user; run as it rather than root.
RUN chown -R bun:bun /app
USER bun

EXPOSE 8080

# Railway health check targets /health/live, which does not touch the
# database — a database blip must not get a healthy process killed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:8080/health/live'); process.exit(r.ok ? 0 : 1)"

# Bun forwards SIGTERM to the process, and src/index.ts drains on it.
CMD ["bun", "apps/api/src/index.ts"]

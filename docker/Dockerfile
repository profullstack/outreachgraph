# syntax=docker/dockerfile:1
#
# The whole application in one image (PRD §1.1, adjusted).
#
# The PWA, the API and the background worker run in a single container as one
# Bun process supervising a Next child. That trades independent scaling for a
# much smaller operational surface: one build, one deploy, one log stream, one
# set of environment variables.
#
# Consequence worth knowing: the worker loop is single-instance by design, so
# this container must not be scaled horizontally without splitting the loop
# back out behind a lock.

FROM oven/bun:1.3.14-slim AS deps
WORKDIR /app

# The whole workspace, deliberately. Enumerating manifests to get a cacheable
# layer broke every time a package was added, and copying only the root
# node_modules loses the per-package trees bun creates.
COPY package.json bun.lock ./
COPY packages ./packages
COPY apps ./apps

RUN bun install --frozen-lockfile

FROM deps AS builder
WORKDIR /app

COPY tsconfig.base.json ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN cd apps/web && bun run build

FROM deps AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=8080
ENV WEB_PORT=3001

COPY tsconfig.base.json tsconfig.json ./
COPY migrations ./migrations

# `outputFileTracingRoot` is the monorepo root, so the standalone bundle keeps
# the apps/web/ layout the supervisor expects at apps/web/server.js.
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public

RUN chown -R bun:bun /app
USER bun

EXPOSE 8080

# /health/live is served by the API and never touches the database, so a
# database blip cannot get a healthy container killed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:8080/health/live'); process.exit(r.ok ? 0 : 1)"

CMD ["bun", "apps/server/src/index.ts"]

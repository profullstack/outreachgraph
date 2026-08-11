# syntax=docker/dockerfile:1
#
# API service (PRD §1.1 "Docker Requirements").
#
# The dependency stage copies the whole workspace rather than enumerating each
# package.json. An earlier version listed them one by one and broke the moment
# a package was added — `bun install --frozen-lockfile` failed on the missing
# workspace member. Copying wholesale costs some layer caching and buys a
# Dockerfile that cannot drift out of sync with the repository.

FROM oven/bun:1.3.14-slim AS deps
WORKDIR /app

COPY package.json bun.lock ./
COPY packages ./packages
COPY apps ./apps

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

# Targets /health/live, which does not touch the database — a database blip
# must not get a healthy process killed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:8080/health/live'); process.exit(r.ok ? 0 : 1)"

# Bun forwards SIGTERM to the process, and src/index.ts drains on it.
CMD ["bun", "apps/api/src/index.ts"]

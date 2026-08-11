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
# The worker's pipeline test imports the API's seed helper, so the API source
# has to be present for the workspace to resolve.
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker

RUN chown -R bun:bun /app
USER bun

EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:8081/health/live'); process.exit(r.ok ? 0 : 1)"

CMD ["bun", "apps/worker/src/index.ts"]

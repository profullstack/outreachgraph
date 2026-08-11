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

# Extends `deps` for the same reason as the API image: Bun leaves some
# workspace dependencies in per-package node_modules, and re-copying `packages/`
# from the build context deletes them, producing an image that builds and then
# crashes on boot. See docker/api.Dockerfile for the full note.
FROM deps AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY tsconfig.base.json tsconfig.json ./
COPY migrations ./migrations

RUN chown -R bun:bun /app
USER bun

EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:8081/health/live'); process.exit(r.ok ? 0 : 1)"

CMD ["bun", "apps/worker/src/index.ts"]

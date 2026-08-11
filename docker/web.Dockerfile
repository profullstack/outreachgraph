# syntax=docker/dockerfile:1
#
# Next.js PWA (PRD §1.1).
#
# Uses Next's `output: 'standalone'` tracing, so the runtime stage copies only
# the traced server plus static assets rather than the whole node_modules tree.

FROM oven/bun:1.3.14-slim AS deps
WORKDIR /app

COPY package.json bun.lock ./
COPY packages ./packages
COPY apps ./apps

RUN bun install --frozen-lockfile

# Extends `deps` rather than re-copying node_modules into a fresh stage.
# Copying only the root node_modules loses the per-package node_modules/.bin
# that Bun's workspace linking creates, and `next` is one of those binaries —
# the build failed with `next: command not found`.
FROM deps AS builder
WORKDIR /app

COPY tsconfig.base.json ./

ENV NEXT_TELEMETRY_DISABLED=1
RUN cd apps/web && bun run build

FROM oven/bun:1.3.14-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

# `outputFileTracingRoot` is the monorepo root, so the standalone bundle keeps
# the apps/web/ path structure and carries its own minimal node_modules.
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public

RUN chown -R bun:bun /app
USER bun

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:3000/offline'); process.exit(r.ok ? 0 : 1)"

CMD ["bun", "apps/web/server.js"]

# syntax=docker/dockerfile:1.7

# Stage 1: deps. Lockfile-driven install for reproducible builds.
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# Use npm ci when a lockfile is present, fall back to npm install otherwise
# (the first build before lockfile is committed). After CI lands, this
# always runs the ci path.
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Stage 2: build. Runs `next build` to produce the standalone output.
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Standalone output mode emits a tree under .next/standalone with only the
# server.js + minimal node_modules required to run. Halves image size vs.
# `next start` against a full build tree.
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Stage 3: runtime. Bare-minimum image. We don't ship npm, lockfiles, or
# source — only the standalone server, .next/static (served at /_next/static
# by the standalone server), and the public/ directory.
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Run as non-root. Next's standalone server doesn't need root to bind 3000.
RUN addgroup -g 1001 nodejs && adduser -D -u 1001 -G nodejs nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# public/ is optional; only copy if it exists (--chown picks it up either way).
COPY --from=builder --chown=nextjs:nodejs /app/public* ./public/

USER nextjs
EXPOSE 3000

# Healthcheck hits the in-process /api/health route which probes the upstream
# api. Container is reported unhealthy if either side breaks.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3000/api/health || exit 1

CMD ["node", "server.js"]

FROM node:22-alpine AS base

# --- Dependencies ---
FROM base AS deps
WORKDIR /app
RUN npm install -g pnpm@10
COPY package.json pnpm-lock.yaml ./
# --ignore-scripts skips postinstall (better-sqlite3 native build)
# The build stage handles native compilation after COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts

# --- Build ---
FROM base AS builder
WORKDIR /app
ENV NODE_OPTIONS="--max-old-space-size=3072"
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_OPTIONS="--max-old-space-size=2048"

RUN pnpm rebuild better-sqlite3 && pnpm run build

# --- Production runner ---
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3326
ENV PORT=3326
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]

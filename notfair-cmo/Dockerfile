# Stage 1: Base — Node with pnpm
FROM node:20-bookworm-slim AS base
RUN npm install -g pnpm@10

# Stage 2: Install deps (build tools needed for better-sqlite3 native module)
FROM base AS deps
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
    python3 make g++ 2>/dev/null || true
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Stage 3: Build
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm run build

# Stage 4: Production runner
FROM node:20-slim AS runner
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

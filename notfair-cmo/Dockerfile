FROM node:22-alpine AS base
RUN npm install -g pnpm@10

# --- Dependencies ---
FROM base AS deps
RUN apk add --no-cache python3 make g++ gcc
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# --- Build ---
FROM base AS builder
ARG BETTER_AUTH_SECRET=placeholder-build-only
ENV BETTER_AUTH_SECRET=$BETTER_AUTH_SECRET
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_OPTIONS="--max-old-space-size=2048"
RUN npx next build

# --- Production runner ---
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/next.config.ts ./next.config.ts
USER nextjs
EXPOSE 3326
ENV PORT=3326
ENV HOSTNAME="0.0.0.0"
CMD ["node_modules/.bin/next", "start", "-p", "3326"]

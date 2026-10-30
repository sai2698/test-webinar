# ─────────────────────────────────────────────────────────────
# NexaLive — Next.js web client
# Multi-stage: deps → build → runtime (standalone output)
# ─────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS base
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    npm_config_update_notifier=false
WORKDIR /app

# ── deps ──────────────────────────────────────────────────────
FROM base AS deps
ENV NODE_ENV=development
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --ignore-scripts --workspaces --include-workspace-root

# ── build ─────────────────────────────────────────────────────
FROM deps AS build
COPY packages/shared packages/shared
COPY apps/web apps/web

# NEXT_PUBLIC_* values are inlined at build time, so they must be present here.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ARG NEXT_PUBLIC_SOCKET_URL=http://localhost:4000
ARG NEXT_PUBLIC_RZP_KEY_ID=
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_SOCKET_URL=$NEXT_PUBLIC_SOCKET_URL \
    NEXT_PUBLIC_RZP_KEY_ID=$NEXT_PUBLIC_RZP_KEY_ID

RUN npm run build -w @webinar/web

# ── runtime ───────────────────────────────────────────────────
FROM base AS runtime
ENV PORT=3000 \
    HOSTNAME=0.0.0.0

# `output: 'standalone'` bundles the server plus only the deps it needs.
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/web/server.js"]

# ─────────────────────────────────────────────────────────────
# NexaLive — API + SFU server
# Multi-stage: deps → build → runtime
# ─────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    NODE_ENV=production \
    npm_config_update_notifier=false
WORKDIR /app

# mediasoup's worker is a native binary; it needs these at runtime.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
      ca-certificates \
      curl \
      libstdc++6 \
 && rm -rf /var/lib/apt/lists/*

# ── deps: install everything (workspaces need the full tree) ──
FROM base AS deps
ENV NODE_ENV=development
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
# `--ignore-scripts` first so a failing mediasoup postinstall cannot abort the
# install; the worker binary is fetched explicitly in the next step.
RUN npm ci --ignore-scripts --workspaces --include-workspace-root
RUN node apps/server/scripts/fetch-mediasoup-worker.mjs || true

# ── build: compile TypeScript ─────────────────────────────────
FROM deps AS build
# The committed schema targets SQLite so `npm run setup` works with no
# external services. Production runs Postgres, so the provider is rewritten
# here rather than keeping two schema files in sync by hand.
ARG DATABASE_PROVIDER=postgresql
COPY packages/shared packages/shared
COPY apps/server apps/server
RUN if [ "$DATABASE_PROVIDER" != "sqlite" ]; then \
      sed -i "s/provider = \"sqlite\"/provider = \"$DATABASE_PROVIDER\"/" \
        apps/server/prisma/schema.prisma; \
    fi \
 && grep -q "provider = \"$DATABASE_PROVIDER\"" apps/server/prisma/schema.prisma \
 && echo "[build] prisma provider = $DATABASE_PROVIDER"
RUN npx prisma generate --schema apps/server/prisma/schema.prisma
RUN npm run build -w @webinar/server

# ── runtime ───────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=4000

# Only the pieces the server needs at runtime.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/prisma ./apps/server/prisma
COPY --from=build /app/apps/server/scripts ./apps/server/scripts
COPY infra/docker/server-entrypoint.sh /usr/local/bin/server-entrypoint.sh

# Prisma needs a writable location for its query engine cache.
RUN chmod +x /usr/local/bin/server-entrypoint.sh \
 && mkdir -p /app/apps/server/prisma \
 && chown -R node:node /app

USER node
WORKDIR /app/apps/server

# The RTP range is bound at runtime from RTC_MIN_PORT/RTC_MAX_PORT, so it is
# documented here rather than hard-coded — a 500-person room needs ~1000 ports.
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/server-entrypoint.sh"]
CMD ["node", "dist/index.js"]

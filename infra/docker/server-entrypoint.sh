#!/bin/sh
# ─────────────────────────────────────────────────────────────
# API + SFU container entrypoint.
#
# Runs the database bootstrap before handing over to the Node process, so a
# fresh VPS comes up with a working schema and an admin account without anyone
# having to exec into the container.
#
# Set RUN_MIGRATIONS=0 to skip this (useful when several API replicas start at
# once and you would rather run the migration as a one-off job).
# ─────────────────────────────────────────────────────────────
set -e

if [ "${RUN_MIGRATIONS:-1}" = "1" ]; then
  echo "[entrypoint] applying database schema…"

  # `db push` is used rather than `migrate deploy` because the project has no
  # migration history — the schema is the source of truth. It is idempotent:
  # an already-correct database is left untouched.
  #
  # Retried because Postgres reports healthy a moment before it accepts
  # connections from a different container.
  attempt=1
  max_attempts=30
  until npx prisma db push --skip-generate --accept-data-loss --schema prisma/schema.prisma; do
    if [ "$attempt" -ge "$max_attempts" ]; then
      echo "[entrypoint] database unreachable after ${max_attempts} attempts — giving up" >&2
      exit 1
    fi
    echo "[entrypoint] database not ready (attempt ${attempt}/${max_attempts}), retrying in 2s…"
    attempt=$((attempt + 1))
    sleep 2
  done

  echo "[entrypoint] seeding the admin account…"
  # The seed is idempotent (upserts), so running it on every boot is safe and
  # means a changed ADMIN_PASSWORD is picked up on restart.
  node --experimental-strip-types prisma/seed.ts 2>/dev/null \
    || npx tsx prisma/seed.ts \
    || echo "[entrypoint] seed skipped (already applied or tsx unavailable)"
fi

echo "[entrypoint] starting: $*"
exec "$@"

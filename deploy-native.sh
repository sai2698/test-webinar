#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Webinar platform — NATIVE deployment for a Linux VPS.
# No Docker. Node runs under systemd, nginx and coturn come from the distro.
#
#   ./deploy-native.sh install     first-time setup: deps, secrets, build, start
#   ./deploy-native.sh up          start the services
#   ./deploy-native.sh down        stop the services
#   ./deploy-native.sh restart     restart without rebuilding
#   ./deploy-native.sh rebuild     rebuild and restart
#   ./deploy-native.sh build       build only (retry a failed build)
#   ./deploy-native.sh logs [svc]  follow logs (api | web | nginx | coturn)
#   ./deploy-native.sh status      service + health status
#   ./deploy-native.sh ports       print the ports to whitelist
#   ./deploy-native.sh firewall    apply the firewall rules (ufw / firewalld)
#   ./deploy-native.sh env         show the resolved configuration
#   ./deploy-native.sh backup      dump the database
#   ./deploy-native.sh destroy     stop and remove the services (asks twice)
#
# Requires: Ubuntu 22.04+ / Debian 12+ (or any distro with systemd + apt).
# Run as root, or as a user with sudo.
# ─────────────────────────────────────────────────────────────
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

ENV_FILE="$SCRIPT_DIR/.env"
ENV_EXAMPLE="$SCRIPT_DIR/deploy/env.production.example"

SERVICE_USER="webinar"
API_SERVICE="webinar-api"
WEB_SERVICE="webinar-web"
NGINX_SITE="webinar"
NGINX_AVAILABLE="/etc/nginx/sites-available/${NGINX_SITE}.conf"
NGINX_ENABLED="/etc/nginx/sites-enabled/${NGINX_SITE}.conf"
COTURN_CONF="/etc/coturn/turnserver.conf"

# ── output helpers ───────────────────────────────────────────
if [ -t 1 ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; R=$'\033[0m'
  RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; CYN=$'\033[36m'
else
  B=''; DIM=''; R=''; RED=''; GRN=''; YEL=''; CYN=''
fi

info()  { printf '%s\n' "${CYN}▸${R} $*"; }
ok()    { printf '%s\n' "${GRN}✔${R} $*"; }
warn()  { printf '%s\n' "${YEL}!${R} $*" >&2; }
die()   { printf '%s\n' "${RED}✖${R} $*" >&2; exit 1; }
hr()    { printf '%s\n' "${DIM}────────────────────────────────────────────────────────────${R}"; }

# `set -E` propagates ERR into functions, so a failure deep in a call chain
# would otherwise print this message once per stack frame.
_ERR_REPORTED=0
_on_err() {
  local rc=$?
  [ "$_ERR_REPORTED" -eq 1 ] && return 0
  _ERR_REPORTED=1
  printf '%s\n' "${RED}✖${R} failed at line $1 (exit $rc) — see the message above" >&2
  exit "$rc"
}
trap '_on_err $LINENO' ERR

# ── privilege handling ───────────────────────────────────────
# Everything that touches /etc or systemd needs root. Re-exec through sudo once
# rather than sprinkling sudo through the script.
SUDO=""
ensure_root() {
  if [ "$(id -u)" -ne 0 ]; then
    command -v sudo >/dev/null 2>&1 || die "Run this as root, or install sudo."
    SUDO="sudo"
  fi
}

# Run a command as another user. `sudo -u` is not available when we are already
# root and sudo is not installed, so fall back to runuser/su.
as_user() {
  local user="$1"; shift
  if [ -n "$SUDO" ]; then
    $SUDO -u "$user" "$@"
  elif command -v runuser >/dev/null 2>&1; then
    runuser -u "$user" -- "$@"
  else
    su -s /bin/bash "$user" -c "$(printf '%q ' "$@")"
  fi
}

# ── .env loading ─────────────────────────────────────────────
load_env() {
  [ -f "$ENV_FILE" ] || die "No .env found. Run: ./deploy-native.sh install"
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
}

env_get() {
  local key="$1" def="${2:-}"
  local val="${!key:-}"
  printf '%s' "${val:-$def}"
}

# ── preflight ────────────────────────────────────────────────
preflight() {
  ensure_root

  command -v systemctl >/dev/null 2>&1 \
    || die "systemd is required. This script targets a normal Linux VPS."

  command -v node >/dev/null 2>&1 \
    || die "Node.js is not installed. Install Node 20+: https://nodejs.org or use nvm."

  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 20 ] || die "Node $(node -v) is too old — this project needs Node 20 or newer."

  command -v npm >/dev/null 2>&1 || die "npm is not installed."

  command -v openssl >/dev/null 2>&1 \
    || die "openssl is missing. Install it: apt-get install -y openssl"

  # Used to render the nginx and coturn configs from their templates.
  command -v envsubst >/dev/null 2>&1 \
    || die "envsubst is missing. Install gettext: apt-get install -y gettext-base"

  local cores
  cores="$(nproc 2>/dev/null || echo 1)"
  if [ "$cores" -lt 4 ]; then
    warn "Only ${cores} CPU core(s). A 500-person webinar wants 8+."
  fi

  # mediasoup ships a prebuilt worker for common platforms; if it has to compile
  # it needs a toolchain.
  if ! command -v g++ >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; then
    warn "g++ / python3 not found — mediasoup may fail if it has to build its worker."
    warn "Install with: apt-get install -y build-essential python3"
  fi

  local mem
  mem="$(mem_total_mb)"
  if [ "$mem" -lt 2048 ]; then
    warn "Only ${mem} MB RAM. The Next.js build needs ~1.5 GB and will be killed"
    warn "by the OOM killer without swap. ensure_swap() will add some, but a"
    warn "1 GB box is a test environment, not a production one."
  fi
}

# ── memory helpers ───────────────────────────────────────────
# Total RAM in MB. /proc/meminfo is always present on Linux; the fallbacks are
# for odd containers.
mem_total_mb() {
  local kb
  kb="$(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null || echo 0)"
  if [ "${kb:-0}" -gt 0 ] 2>/dev/null; then
    echo $(( kb / 1024 ))
    return
  fi
  echo 0
}

swap_total_mb() {
  local kb
  kb="$(awk '/^SwapTotal:/{print $2}' /proc/meminfo 2>/dev/null || echo 0)"
  if [ "${kb:-0}" -gt 0 ] 2>/dev/null; then
    echo $(( kb / 1024 ))
    return
  fi
  echo 0
}

# A 1 vCPU / 1 GB VPS cannot build this project without swap: `next build`
# peaks around 1.2-1.5 GB and the kernel kills it. Adding a swapfile is the
# difference between a working deploy and an unexplained exit 137.
ensure_swap() {
  local mem swap want_mb
  mem="$(mem_total_mb)"
  swap="$(swap_total_mb)"

  # Plenty of RAM and some swap already — nothing to do.
  if [ "$mem" -ge 2048 ] && [ "$swap" -gt 0 ]; then
    return 0
  fi
  if [ "$mem" -ge 4096 ]; then
    return 0
  fi

  # Target: enough swap that RAM + swap clears ~3 GB.
  want_mb=$(( 3072 - mem ))
  [ "$want_mb" -lt 1024 ] && want_mb=1024
  [ "$want_mb" -gt 4096 ] && want_mb=4096

  if [ "$swap" -ge "$want_mb" ]; then
    ok "swap already sufficient (${swap} MB)"
    return 0
  fi

  if [ -e /swapfile ]; then
    warn "/swapfile exists but is not active — trying to enable it."
    $SUDO swapon /swapfile 2>/dev/null || true
    if [ "$(swap_total_mb)" -gt 0 ]; then
      ok "swap enabled ($(swap_total_mb) MB)"
      return 0
    fi
    warn "Could not enable /swapfile; leaving it alone."
    return 0
  fi

  info "Adding a ${want_mb} MB swapfile (RAM is ${mem} MB — the build needs it)…"

  # fallocate is instant but unsupported on some filesystems (notably ZFS and
  # some overlay setups); dd always works.
  if ! $SUDO fallocate -l "${want_mb}M" /swapfile 2>/dev/null; then
    $SUDO dd if=/dev/zero of=/swapfile bs=1M count="$want_mb" status=none
  fi
  $SUDO chmod 600 /swapfile
  $SUDO mkswap /swapfile >/dev/null
  $SUDO swapon /swapfile

  # Persist across reboots, but only once.
  if ! grep -qE '^/swapfile[[:space:]]' /etc/fstab 2>/dev/null; then
    printf '/swapfile none swap sw 0 0\n' | $SUDO tee -a /etc/fstab >/dev/null
  fi

  # Prefer RAM, but let the build spill to swap instead of dying.
  $SUDO sysctl -qw vm.swappiness=10 2>/dev/null || true

  ok "swap enabled ($(swap_total_mb) MB total)"
}

# ── public IP detection ──────────────────────────────────────
detect_public_ip() {
  local ip=""
  for url in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
    ip="$(curl -fsS --max-time 5 "$url" 2>/dev/null | tr -d '[:space:]')" || true
    if printf '%s' "$ip" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'; then
      printf '%s' "$ip"
      return 0
    fi
  done
  return 1
}

# ── secret generation ────────────────────────────────────────
gen_secret() {
  openssl rand -base64 48 2>/dev/null | tr -d '\n=+/' | cut -c1-"${1:-48}" \
    || head -c 64 /dev/urandom | base64 | tr -d '\n=+/' | cut -c1-"${1:-48}"
}

# ── port plan ────────────────────────────────────────────────
print_ports() {
  load_env

  local http_port api_port web_port
  local rtc_min rtc_max turn_port turn_tls turn_min turn_max
  local pg_port

  http_port="$(env_get HTTP_PORT 5173)"
  api_port="$(env_get API_PORT 4000)"
  web_port="$(env_get WEB_PORT 3000)"
  rtc_min="$(env_get RTC_MIN_PORT 40000)"
  rtc_max="$(env_get RTC_MAX_PORT 42000)"
  turn_port="$(env_get TURN_PORT 3478)"
  turn_tls="$(env_get TURN_TLS_PORT 5349)"
  turn_min="$(env_get TURN_MIN_PORT 49152)"
  turn_max="$(env_get TURN_MAX_PORT 65535)"
  pg_port="$(env_get POSTGRES_PORT 5432)"

  local rtc_count=$(( rtc_max - rtc_min + 1 ))
  local peer_capacity=$(( rtc_count / 2 ))

  hr
  printf '%s\n' "${B}PORTS TO WHITELIST${R}"
  hr
  printf '%s\n' "${DIM}Open these in your cloud provider's security group AND the host firewall.${R}"
  printf '\n'

  printf '%s\n' "${B}PUBLIC — must be reachable from the internet${R}"
  printf '  %-22s %-10s %s\n' "PORT" "PROTO" "PURPOSE"
  printf '  %-22s %-10s %s\n' "----" "-----" "-------"
  printf '  %-22s %-10s %s\n' "$http_port" "tcp" "HTTP(S) — web app + API + websocket (via nginx)"
  printf '  %-22s %-10s %s\n' "$rtc_min-$rtc_max" "udp" "WebRTC media (mediasoup) — ${rtc_count} ports"
  printf '  %-22s %-10s %s\n' "$rtc_min-$rtc_max" "tcp" "WebRTC media fallback when UDP is blocked"
  printf '  %-22s %-10s %s\n' "$turn_port" "udp+tcp" "TURN relay — for restrictive networks"
  printf '  %-22s %-10s %s\n' "$turn_tls" "tcp" "TURN over TLS"
  printf '  %-22s %-10s %s\n' "$turn_min-$turn_max" "udp" "TURN relay port range"
  printf '\n'

  printf '%s\n' "${B}PRIVATE — loopback only, do NOT expose${R}"
  printf '  %-22s %-10s %s\n' "$api_port" "tcp" "API + SFU (nginx proxies to it)"
  printf '  %-22s %-10s %s\n' "$web_port" "tcp" "Next.js (nginx proxies to it)"
  printf '  %-22s %-10s %s\n' "$pg_port" "tcp" "PostgreSQL (skip if using SQLite)"
  printf '\n'

  hr
  printf '%s\n' "${B}CAPACITY${R}"
  hr
  printf '  RTP range %s-%s = %s ports\n' "$rtc_min" "$rtc_max" "$rtc_count"
  printf '  Each peer uses 2 transports (send + recv) = 2 ports\n'
  printf '  %s→ roughly %s concurrent peers%s\n' "${GRN}" "$peer_capacity" "${R}"
  printf '\n'
  printf '  %sThe range is shared by all mediasoup workers, not per worker.%s\n' "${YEL}" "${R}"
  printf '  %sRaising MEDIASOUP_WORKERS does NOT increase capacity — only the range does.%s\n' "${YEL}" "${R}"
  printf '\n'
  printf '  For 500 peers you need at least 1000 ports. Current headroom: %s peers.\n' "$peer_capacity"
  if [ "$peer_capacity" -lt 500 ]; then
    printf '  %sWiden RTC_MAX_PORT to %s for 500 peers.%s\n' \
      "${YEL}" "$(( rtc_min + 1000 ))" "${R}"
  fi
  printf '\n'

  hr
  printf '%s\n' "${B}COPY-PASTE FIREWALL RULES${R}"
  hr
  printf '%s\n' "${DIM}ufw:${R}"
  printf '  ufw allow %s/tcp\n' "$http_port"
  printf '  ufw allow %s:%s/udp\n' "$rtc_min" "$rtc_max"
  printf '  ufw allow %s:%s/tcp\n' "$rtc_min" "$rtc_max"
  printf '  ufw allow %s\n' "$turn_port"
  printf '  ufw allow %s/tcp\n' "$turn_tls"
  printf '  ufw allow %s:%s/udp\n' "$turn_min" "$turn_max"
  printf '\n'
  printf '%s\n' "${DIM}firewalld:${R}"
  printf '  firewall-cmd --permanent --add-port=%s/tcp\n' "$http_port"
  printf '  firewall-cmd --permanent --add-port=%s-%s/udp\n' "$rtc_min" "$rtc_max"
  printf '  firewall-cmd --permanent --add-port=%s-%s/tcp\n' "$rtc_min" "$rtc_max"
  printf '  firewall-cmd --permanent --add-port=%s/udp\n' "$turn_port"
  printf '  firewall-cmd --permanent --add-port=%s/tcp\n' "$turn_port"
  printf '  firewall-cmd --permanent --add-port=%s/tcp\n' "$turn_tls"
  printf '  firewall-cmd --permanent --add-port=%s-%s/udp\n' "$turn_min" "$turn_max"
  printf '  firewall-cmd --reload\n'
  printf '\n'
  printf '%s\n' "${DIM}Or let this script do it:${R}  ./deploy-native.sh firewall"
  hr
}

# ── firewall ─────────────────────────────────────────────────
apply_firewall() {
  ensure_root
  load_env

  local http_port rtc_min rtc_max turn_port turn_tls turn_min turn_max
  http_port="$(env_get HTTP_PORT 80)"
  rtc_min="$(env_get RTC_MIN_PORT 40000)"
  rtc_max="$(env_get RTC_MAX_PORT 42000)"
  turn_port="$(env_get TURN_PORT 3478)"
  turn_tls="$(env_get TURN_TLS_PORT 5349)"
  turn_min="$(env_get TURN_MIN_PORT 49152)"
  turn_max="$(env_get TURN_MAX_PORT 65535)"

  if command -v ufw >/dev/null 2>&1; then
    info "Applying ufw rules…"
    $SUDO ufw allow "$http_port"/tcp            >/dev/null
    $SUDO ufw allow "$rtc_min:$rtc_max"/udp     >/dev/null
    $SUDO ufw allow "$rtc_min:$rtc_max"/tcp     >/dev/null
    $SUDO ufw allow "$turn_port"                >/dev/null
    $SUDO ufw allow "$turn_tls"/tcp             >/dev/null
    $SUDO ufw allow "$turn_min:$turn_max"/udp   >/dev/null
    ok "ufw rules applied"
    $SUDO ufw status numbered | sed 's/^/  /'
  elif command -v firewall-cmd >/dev/null 2>&1; then
    info "Applying firewalld rules…"
    $SUDO firewall-cmd --permanent --add-port="$http_port"/tcp          >/dev/null
    $SUDO firewall-cmd --permanent --add-port="$rtc_min-$rtc_max"/udp   >/dev/null
    $SUDO firewall-cmd --permanent --add-port="$rtc_min-$rtc_max"/tcp   >/dev/null
    $SUDO firewall-cmd --permanent --add-port="$turn_port"/udp          >/dev/null
    $SUDO firewall-cmd --permanent --add-port="$turn_port"/tcp          >/dev/null
    $SUDO firewall-cmd --permanent --add-port="$turn_tls"/tcp           >/dev/null
    $SUDO firewall-cmd --permanent --add-port="$turn_min-$turn_max"/udp >/dev/null
    $SUDO firewall-cmd --reload >/dev/null
    ok "firewalld rules applied"
    $SUDO firewall-cmd --list-ports | tr ' ' '\n' | sed 's/^/  /'
  else
    warn "Neither ufw nor firewalld found — apply the rules from './deploy-native.sh ports' manually."
    warn "Remember to also open these in your cloud provider's security group."
    return 0
  fi

  printf '\n'
  warn "Host firewall done. You STILL need to open the same ports in the"
  warn "cloud provider's security group (AWS SG / GCP firewall / Hetzner / DO)."
}

# ── system user ──────────────────────────────────────────────
ensure_service_user() {
  if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
    info "Creating the '${SERVICE_USER}' system user…"
    # --user-group matters: plain `useradd --system` does NOT create a group of
    # the same name on Debian/Ubuntu, and every chown below would then fail.
    $SUDO useradd --system --user-group --create-home \
      --shell /usr/sbin/nologin "$SERVICE_USER"
    ok "user ${SERVICE_USER} created"
  fi

  # Resolve the group to use for ownership. Prefer a same-named group, fall
  # back to the user's primary group.
  local group
  if getent group "$SERVICE_USER" >/dev/null 2>&1; then
    group="$SERVICE_USER"
  else
    group="$(id -gn "$SERVICE_USER")"
  fi

  # Only the paths the running services must WRITE are handed over. Chowning the
  # whole repo would break the git checkout for whoever deployed it.
  local writable=(
    "$SCRIPT_DIR/apps/server/prisma"
    "$SCRIPT_DIR/apps/web/.next"
    "$SCRIPT_DIR/recordings"
    "$SCRIPT_DIR/backups"
  )
  local p
  for p in "${writable[@]}"; do
    [ -e "$p" ] || mkdir -p "$p"
    $SUDO chown -R "${SERVICE_USER}:${group}" "$p"
  done

  # The service user must be able to read the code and node_modules. Default
  # umask already gives 755/644, so this only matters for an unusual checkout.
  if ! $SUDO -u "$SERVICE_USER" head -c 1 "$SCRIPT_DIR/package.json" >/dev/null 2>&1; then
    warn "${SERVICE_USER} cannot read ${SCRIPT_DIR} — fixing permissions."
    $SUDO chmod -R a+rX "$SCRIPT_DIR"
  fi
}

# ── database ─────────────────────────────────────────────────
setup_database() {
  load_env
  local provider
  provider="$(env_get DATABASE_PROVIDER sqlite)"

  if [ "$provider" = "sqlite" ]; then
    info "Using SQLite — no database server needed."
    # Prisma resolves a relative file: URL against the schema directory.
    set_env DATABASE_URL "file:./prod.db"
    return 0
  fi

  info "Configuring PostgreSQL…"
  if ! command -v psql >/dev/null 2>&1; then
    info "Installing postgresql…"
    $SUDO apt-get update -qq
    $SUDO apt-get install -y -qq postgresql postgresql-contrib
  fi
  $SUDO systemctl enable --now postgresql >/dev/null 2>&1 || true

  local pg_user pg_db pg_pw pg_port
  pg_user="$(env_get POSTGRES_USER webinar)"
  pg_db="$(env_get POSTGRES_DB webinar)"
  pg_pw="$(env_get POSTGRES_PASSWORD)"
  pg_port="$(env_get POSTGRES_PORT 5432)"

  # Idempotent: create the role only if it is missing, then always set the
  # password so a re-run picks up a rotated secret.
  if ! as_user postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${pg_user}'" | grep -q 1; then
    as_user postgres psql -c "CREATE ROLE ${pg_user} LOGIN PASSWORD '${pg_pw}';" >/dev/null
    ok "role ${pg_user} created"
  else
    as_user postgres psql -c "ALTER ROLE ${pg_user} WITH LOGIN PASSWORD '${pg_pw}';" >/dev/null
  fi

  if ! as_user postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${pg_db}'" | grep -q 1; then
    as_user postgres createdb -O "$pg_user" "$pg_db"
    ok "database ${pg_db} created"
  fi

  set_env DATABASE_URL "postgresql://${pg_user}:${pg_pw}@127.0.0.1:${pg_port}/${pg_db}?schema=public"

  # The committed schema targets SQLite so local dev needs no services. Rewrite
  # the provider in place for this deployment.
  local schema="$SCRIPT_DIR/apps/server/prisma/schema.prisma"
  if grep -q 'provider = "sqlite"' "$schema"; then
    sed -i 's/provider = "sqlite"/provider = "postgresql"/' "$schema"
    ok "prisma provider switched to postgresql"
  fi
}

# ── .env writing ─────────────────────────────────────────────
set_env() {
  local key="$1" val="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    local esc
    esc="$(printf '%s' "$val" | sed -e 's/[&|\\]/\\&/g')"
    sed -i "s|^${key}=.*|${key}=${esc}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}

# ── nginx ────────────────────────────────────────────────────
setup_nginx() {
  ensure_root
  load_env

  if ! command -v nginx >/dev/null 2>&1; then
    info "Installing nginx…"
    $SUDO apt-get update -qq
    $SUDO apt-get install -y -qq nginx
  fi

  local http_port server_name api_port web_port
  http_port="$(env_get HTTP_PORT 5173)"
  server_name="$(env_get SERVER_NAME _)"
  api_port="$(env_get API_PORT 4000)"
  web_port="$(env_get WEB_PORT 3000)"

  info "Writing the nginx site…"

  # Rendered from the same template the Docker path uses, so the two cannot
  # drift. nginx only speaks plain HTTP here: Caddy on this host owns 80/443,
  # terminates TLS, and forwards to HTTP_PORT. No certs, no ACME webroot.
  local tpl="$SCRIPT_DIR/infra/nginx/templates/default.conf.template"
  [ -f "$tpl" ] || die "Missing $tpl"

  local rendered
  rendered="$(mktemp)"
  HTTP_PORT="$http_port" SERVER_NAME="$server_name" \
  API_PORT="$api_port" WEB_PORT="$web_port" \
    envsubst '${HTTP_PORT} ${SERVER_NAME} ${API_PORT} ${WEB_PORT}' \
    < "$tpl" > "$rendered"

  # The template's upstreams point at 127.0.0.1, which is correct here too.
  $SUDO install -m 644 "$rendered" "$NGINX_AVAILABLE"
  rm -f "$rendered"

  $SUDO ln -sf "$NGINX_AVAILABLE" "$NGINX_ENABLED"

  # The distro's default site also listens on 80 and would shadow ours.
  if [ -e /etc/nginx/sites-enabled/default ]; then
    $SUDO rm -f /etc/nginx/sites-enabled/default
    ok "removed the distro's default nginx site"
  fi

  $SUDO nginx -t || die "nginx rejected the generated config — see the error above."
  $SUDO systemctl enable --now nginx >/dev/null 2>&1 || true
  $SUDO systemctl reload nginx
  ok "nginx listening on plain HTTP port ${http_port} (TLS is Caddy's job)"
}

# ── coturn ───────────────────────────────────────────────────
setup_coturn() {
  ensure_root
  load_env

  if ! command -v turnserver >/dev/null 2>&1; then
    info "Installing coturn…"
    $SUDO apt-get update -qq
    $SUDO apt-get install -y -qq coturn
  fi

  local tpl="$SCRIPT_DIR/infra/coturn/turnserver.conf.template"
  [ -f "$tpl" ] || die "Missing $tpl"

  info "Writing the coturn config…"
  local rendered
  rendered="$(mktemp)"
  PUBLIC_IP="$(env_get PUBLIC_IP 127.0.0.1)" \
  TURN_PORT="$(env_get TURN_PORT 3478)" \
  TURN_TLS_PORT="$(env_get TURN_TLS_PORT 5349)" \
  TURN_REALM="$(env_get TURN_REALM webinar.local)" \
  TURN_USERNAME="$(env_get TURN_USERNAME webinar)" \
  TURN_PASSWORD="$(env_get TURN_PASSWORD)" \
  TURN_MIN_PORT="$(env_get TURN_MIN_PORT 49152)" \
  TURN_MAX_PORT="$(env_get TURN_MAX_PORT 65535)" \
    envsubst '$PUBLIC_IP $TURN_PORT $TURN_TLS_PORT $TURN_REALM $TURN_USERNAME $TURN_PASSWORD $TURN_MIN_PORT $TURN_MAX_PORT' \
    < "$tpl" > "$rendered"

  $SUDO install -d -m 755 /etc/coturn
  $SUDO install -m 640 -g turnserver "$rendered" "$COTURN_CONF" 2>/dev/null \
    || $SUDO install -m 600 "$rendered" "$COTURN_CONF"
  rm -f "$rendered"

  # Debian/Ubuntu ship coturn disabled by default.
  if [ -f /etc/default/coturn ]; then
    $SUDO sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
  fi

  $SUDO systemctl enable --now coturn >/dev/null 2>&1 || true
  $SUDO systemctl restart coturn
  ok "coturn configured"
}

# ── systemd units ────────────────────────────────────────────
write_units() {
  ensure_root
  load_env

  local api_port web_port
  api_port="$(env_get API_PORT 4000)"
  web_port="$(env_get WEB_PORT 3000)"

  info "Writing systemd units…"

  $SUDO tee "/etc/systemd/system/${API_SERVICE}.service" >/dev/null <<EOF
[Unit]
Description=Webinar platform — API + SFU
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${SCRIPT_DIR}
EnvironmentFile=${ENV_FILE}
Environment=NODE_ENV=production
Environment=PORT=${api_port}
ExecStart=/usr/bin/env node apps/server/dist/index.js
Restart=always
RestartSec=3
# mediasoup opens a large UDP range; the default fd limit is too low.
LimitNOFILE=65535
# Give the SFU a moment to shut its transports down cleanly.
TimeoutStopSec=20

StandardOutput=journal
StandardError=journal
SyslogIdentifier=${API_SERVICE}

[Install]
WantedBy=multi-user.target
EOF

  $SUDO tee "/etc/systemd/system/${WEB_SERVICE}.service" >/dev/null <<EOF
[Unit]
Description=Webinar platform — web client
After=network-online.target ${API_SERVICE}.service
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${SCRIPT_DIR}/apps/web
EnvironmentFile=${ENV_FILE}
Environment=NODE_ENV=production
Environment=PORT=${web_port}
ExecStart=${SCRIPT_DIR}/node_modules/.bin/next start -p ${web_port}
Restart=always
RestartSec=3
LimitNOFILE=65535

StandardOutput=journal
StandardError=journal
SyslogIdentifier=${WEB_SERVICE}

[Install]
WantedBy=multi-user.target
EOF

  $SUDO systemctl daemon-reload
  ok "units written"
}

# ── build ────────────────────────────────────────────────────
build_apps() {
  load_env

  # Built as the invoking user, not the service user: node_modules and .next
  # stay owned by whoever deployed, and the service only needs read access.
  #
  # On a small VPS this is the step that hurts. Three things keep it alive:
  #   1. swap (ensure_swap) so the OOM killer has somewhere to go
  #   2. a capped V8 heap so node collects instead of growing to the limit
  #   3. --maxsockets 1 so npm does not open 16 parallel connections on 1 vCPU
  ensure_swap

  local mem
  mem="$(mem_total_mb)"
  local heap_mb=2048
  if [ "$mem" -gt 0 ] && [ "$mem" -lt 2048 ]; then
    # Leave headroom for the OS; the rest is the build's budget.
    heap_mb=$(( mem - 256 ))
    [ "$heap_mb" -lt 768 ] && heap_mb=768
  fi
  export NODE_OPTIONS="--max-old-space-size=${heap_mb}"
  info "Node heap capped at ${heap_mb} MB (RAM: ${mem} MB, swap: $(swap_total_mb) MB)"

  # npm's default concurrency is fine on 8 cores and pathological on 1.
  local npm_flags=(--include=dev --no-audit --no-fund)
  if [ "$(nproc 2>/dev/null || echo 1)" -le 2 ]; then
    npm_flags+=(--maxsockets 1)
    info "Low core count — installing dependencies serially (this is slow, be patient)"
  fi

  info "Installing dependencies…"
  npm ci "${npm_flags[@]}" || npm install "${npm_flags[@]}"

  info "Generating the Prisma client…"
  npx prisma generate --schema apps/server/prisma/schema.prisma

  info "Applying the database schema…"
  npx prisma db push --skip-generate --accept-data-loss --schema apps/server/prisma/schema.prisma

  info "Seeding the admin account…"
  npx tsx apps/server/prisma/seed.ts || warn "seed skipped (already applied)"

  # Build the two workspaces separately rather than via the root `build` script.
  # The root script chains them with &&, so a failure in the second one gives no
  # clue which half died, and on a small box it is useful to know that the API
  # compiled before the web build started swapping.
  info "Building the API (tsc)…"
  npm run build -w @webinar/server

  info "Building the web client (next build — the slow, memory-hungry step)…"
  # These must be present at build time or the browser bundle points at the
  # wrong host. They come from .env, which is why install writes it first.
  NEXT_PUBLIC_API_URL="$(env_get NEXT_PUBLIC_API_URL)" \
  NEXT_PUBLIC_SOCKET_URL="$(env_get NEXT_PUBLIC_SOCKET_URL)" \
  NEXT_PUBLIC_RZP_KEY_ID="$(env_get NEXT_PUBLIC_RZP_KEY_ID)" \
  NEXT_TELEMETRY_DISABLED=1 \
  CI=1 \
    npm run build -w @webinar/web

  # The build just rewrote .next and the SQLite file; hand them back.
  local group
  if getent group "$SERVICE_USER" >/dev/null 2>&1; then
    group="$SERVICE_USER"
  else
    group="$(id -gn "$SERVICE_USER")"
  fi
  local p
  for p in "$SCRIPT_DIR/apps/server/prisma" "$SCRIPT_DIR/apps/web/.next"; do
    [ -e "$p" ] && $SUDO chown -R "${SERVICE_USER}:${group}" "$p"
  done

  ok "build complete"
}

# ── health ───────────────────────────────────────────────────
wait_healthy() {
  load_env
  local api_port
  api_port="$(env_get API_PORT 4000)"

  local i
  for i in $(seq 1 60); do
    if curl -fsS --max-time 3 "http://127.0.0.1:${api_port}/api/health" >/dev/null 2>&1; then
      local body
      body="$(curl -fsS --max-time 3 "http://127.0.0.1:${api_port}/api/health")"
      ok "API healthy: $body"
      return 0
    fi
    sleep 2
  done

  warn "API did not become healthy within 120s."
  warn "Check the logs:  ./deploy-native.sh logs api"
  return 1
}

# ── install ──────────────────────────────────────────────────
cmd_install() {
  preflight

  if [ -f "$ENV_FILE" ]; then
    warn ".env already exists — leaving it alone."
    warn "Delete it and re-run if you want fresh secrets."
  else
    info "Creating .env with generated secrets…"

    local public_ip
    public_ip="$(detect_public_ip || true)"
    if [ -z "$public_ip" ]; then
      warn "Could not detect the public IP automatically."
      read -rp "  Enter this server's public IPv4: " public_ip
      [ -n "$public_ip" ] || die "A public IP is required for WebRTC."
    else
      ok "Detected public IP: $public_ip"
    fi

    local domain
    read -rp "  Domain name (blank to serve on the IP): " domain
    domain="${domain:-$public_ip}"

    # TLS is terminated by Caddy on this host, not by nginx. So the public
    # origin is https://<domain> whenever a real domain is used, and plain
    # http://<ip> only when there is no domain to put a certificate on.
    local web_origin
    if [ "$domain" != "$public_ip" ]; then
      web_origin="https://${domain}"
      info "Caddy on this host terminates TLS; nginx will listen on plain HTTP."
    else
      web_origin="http://${domain}"
      warn "No domain given — Caddy cannot obtain a certificate for a bare IP."
    fi

    local db_choice
    read -rp "  Database — [1] PostgreSQL (recommended) [2] SQLite (single server, simple): " db_choice
    local provider="postgresql"
    [ "${db_choice:-1}" = "2" ] && provider="sqlite"

    local jwt admin_pw pg_pw turn_pw
    jwt="$(gen_secret 48)"
    admin_pw="$(gen_secret 20)"
    pg_pw="$(gen_secret 32)"
    turn_pw="$(gen_secret 32)"

    [ -f "$ENV_EXAMPLE" ] || die "Missing $ENV_EXAMPLE"
    cp "$ENV_EXAMPLE" "$ENV_FILE"

    set_env NODE_ENV production
    set_env DATABASE_PROVIDER "$provider"
    set_env PUBLIC_IP "$public_ip"
    set_env MEDIASOUP_ANNOUNCED_IP "$public_ip"
    set_env SERVER_NAME "$domain"
    set_env WEB_ORIGIN "$web_origin"
    # NOTE: no /api suffix. apps/web/lib/api.ts does fetch(`${API_URL}${path}`)
    # and every path already starts with /api, so a suffix here yields
    # https://host/api/api/... and every request 404s.
    set_env NEXT_PUBLIC_API_URL "$web_origin"
    set_env NEXT_PUBLIC_SOCKET_URL "$web_origin"
    set_env JWT_SECRET "$jwt"
    set_env ADMIN_PASSWORD "$admin_pw"
    set_env POSTGRES_PASSWORD "$pg_pw"
    set_env TURN_URL "turn:${public_ip}:3478"
    set_env TURN_USERNAME "webinar"
    set_env TURN_PASSWORD "$turn_pw"
    set_env TURN_REALM "$domain"
    set_env HTTP_PORT "5173"

    chmod 600 "$ENV_FILE"
    ok ".env written (mode 600)"

    printf '\n'
    hr
    printf '%s\n' "${B}SAVE THESE CREDENTIALS${R}"
    hr
    printf '  Admin URL       %s\n' "${web_origin}/admin/login"
    printf '  Admin email     %s\n' "$(grep -E '^ADMIN_EMAIL=' "$ENV_FILE" | cut -d= -f2-)"
    printf '  Admin password  %s%s%s\n' "${B}" "$admin_pw" "${R}"
    printf '\n'
    printf '  %sThe password is stored in .env and will not be shown again.%s\n' "${DIM}" "${R}"
    hr
    printf '\n'
  fi

  ensure_service_user
  setup_database
  build_apps
  write_units
  setup_nginx
  setup_coturn

  info "Starting the services…"
  $SUDO systemctl enable --now "$API_SERVICE" >/dev/null 2>&1 || true
  $SUDO systemctl restart "$API_SERVICE"
  $SUDO systemctl enable --now "$WEB_SERVICE" >/dev/null 2>&1 || true
  $SUDO systemctl restart "$WEB_SERVICE"

  info "Waiting for the API to become healthy…"
  wait_healthy || warn "The services are up but the API is not answering yet — check './deploy-native.sh logs api'."

  printf '\n'
  ok "Deployment complete."
  printf '\n'
  print_ports
}

# ── commands ─────────────────────────────────────────────────
cmd_up() {
  ensure_root
  load_env
  $SUDO systemctl start "$API_SERVICE" "$WEB_SERVICE" nginx coturn
  wait_healthy || true
}

cmd_down() {
  ensure_root
  $SUDO systemctl stop "$WEB_SERVICE" "$API_SERVICE" || true
  ok "Services stopped (nginx and coturn left running — stop them with systemctl)"
}

cmd_restart() {
  ensure_root
  load_env
  $SUDO systemctl restart "$API_SERVICE" "$WEB_SERVICE"
  $SUDO systemctl reload nginx 2>/dev/null || true
  wait_healthy || true
}

cmd_rebuild() {
  preflight
  load_env
  build_apps
  $SUDO systemctl restart "$API_SERVICE" "$WEB_SERVICE"
  wait_healthy || true
}

# Build only. Useful when `install` died in the build step on a small VPS: the
# .env, the service user and the database are already in place, so re-running
# the whole install would be wasted work.
cmd_build() {
  preflight
  load_env
  build_apps
  ok "Build finished. Start it with: ./deploy-native.sh restart"
}

cmd_logs() {
  ensure_root
  local svc="${1:-api}"
  case "$svc" in
    api|server)  $SUDO journalctl -u "$API_SERVICE" -f --no-pager -n 200 ;;
    web)         $SUDO journalctl -u "$WEB_SERVICE" -f --no-pager -n 200 ;;
    nginx)       $SUDO journalctl -u nginx -f --no-pager -n 200 ;;
    coturn)      $SUDO journalctl -u coturn -f --no-pager -n 200 ;;
    *)           die "Unknown service: $svc (api | web | nginx | coturn)" ;;
  esac
}

cmd_status() {
  ensure_root
  load_env
  for s in "$API_SERVICE" "$WEB_SERVICE" nginx coturn; do
    local state
    state="$($SUDO systemctl is-active "$s" 2>/dev/null || true)"
    if [ "$state" = "active" ]; then
      printf '  %s✔%s %-16s %s\n' "$GRN" "$R" "$s" "$state"
    else
      printf '  %s✖%s %-16s %s\n' "$RED" "$R" "$s" "${state:-unknown}"
    fi
  done
  printf '\n'
  local api_port
  api_port="$(env_get API_PORT 4000)"
  if curl -fsS --max-time 3 "http://127.0.0.1:${api_port}/api/health" 2>/dev/null; then
    printf '\n'
    ok "API responding"
  else
    printf '\n'
    warn "API not responding on 127.0.0.1:${api_port}"
  fi
}

cmd_env() {
  load_env
  hr
  printf '%s\n' "${B}RESOLVED CONFIGURATION${R}"
  hr
  local key val
  while IFS='=' read -r key val; do
    case "$key" in
      ''|\#*) continue ;;
    esac
    case "$key" in
      *SECRET*|*PASSWORD*|*KEY*)
        if [ -n "$val" ]; then val="<set:${#val} chars>"; else val="<empty>"; fi ;;
    esac
    printf '  %-28s %s\n' "$key" "$val"
  done < "$ENV_FILE"
  hr
}

cmd_backup() {
  ensure_root
  load_env
  local dir="$SCRIPT_DIR/backups"
  mkdir -p "$dir"
  local stamp
  stamp="$(date +%Y%m%d-%H%M%S)"

  local provider
  provider="$(env_get DATABASE_PROVIDER sqlite)"

  if [ "$provider" = "sqlite" ]; then
    local db="$SCRIPT_DIR/apps/server/prisma/prod.db"
    [ -f "$db" ] || die "No SQLite database at $db"
    local out="$dir/webinar-${stamp}.db"
    cp "$db" "$out"
    gzip -f "$out"
    ok "Backup written: ${out}.gz ($(du -h "${out}.gz" | cut -f1))"
  else
    local out="$dir/webinar-${stamp}.sql"
    info "Dumping database…"
    as_user postgres pg_dump "$(env_get POSTGRES_DB webinar)" > "$out"
    gzip -f "$out"
    ok "Backup written: ${out}.gz ($(du -h "${out}.gz" | cut -f1))"
  fi
}

cmd_destroy() {
  ensure_root
  warn "This stops and removes the systemd units, the nginx site and the coturn config."
  warn "The database and the code are NOT deleted."
  read -rp "  Type 'destroy' to confirm: " a
  [ "$a" = "destroy" ] || die "Aborted."
  read -rp "  Are you absolutely sure? [y/N]: " b
  [ "${b,,}" = "y" ] || die "Aborted."

  $SUDO systemctl disable --now "$WEB_SERVICE" "$API_SERVICE" 2>/dev/null || true
  $SUDO rm -f "/etc/systemd/system/${API_SERVICE}.service" "/etc/systemd/system/${WEB_SERVICE}.service"
  $SUDO systemctl daemon-reload
  $SUDO rm -f "$NGINX_ENABLED" "$NGINX_AVAILABLE"
  $SUDO nginx -t >/dev/null 2>&1 && $SUDO systemctl reload nginx || true
  ok "Services and nginx site removed. The database and code are untouched."
}

usage() {
  cat <<EOF
${B}Webinar platform — native deployment (no Docker)${R}

  ./deploy-native.sh install     First-time setup: deps, secrets, build, start
  ./deploy-native.sh up          Start the services
  ./deploy-native.sh down        Stop the services
  ./deploy-native.sh restart     Restart without rebuilding
  ./deploy-native.sh rebuild     Rebuild and restart
  ./deploy-native.sh build       Build only (retry a failed build)
  ./deploy-native.sh logs [svc]  Follow logs (api, web, nginx, coturn)
  ./deploy-native.sh status      Service and health status
  ./deploy-native.sh ports       Print the ports to whitelist
  ./deploy-native.sh firewall    Apply firewall rules (ufw / firewalld)
  ./deploy-native.sh env         Show the resolved configuration (secrets masked)
  ./deploy-native.sh backup      Dump the database to ./backups
  ./deploy-native.sh destroy     Remove the services (keeps data)

${DIM}Configuration lives in .env — see deploy/env.production.example.${R}
${DIM}Requires Node 20+, systemd, and root (or sudo).${R}
EOF
}

main() {
  local cmd="${1:-}"
  shift || true
  case "$cmd" in
    install)  cmd_install "$@" ;;
    up)       cmd_up "$@" ;;
    down)     cmd_down "$@" ;;
    restart)  cmd_restart "$@" ;;
    rebuild)  cmd_rebuild "$@" ;;
    build)    cmd_build "$@" ;;
    logs)     cmd_logs "$@" ;;
    status)   cmd_status "$@" ;;
    ports)    print_ports "$@" ;;
    firewall) apply_firewall "$@" ;;
    env)      cmd_env "$@" ;;
    backup)   cmd_backup "$@" ;;
    destroy)  cmd_destroy "$@" ;;
    ''|-h|--help|help) usage ;;
    *) die "Unknown command: $cmd (try --help)" ;;
  esac
}

main "$@"

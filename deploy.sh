#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Webinar platform — one-command deployment for a Linux VPS.
#
#   ./deploy.sh install     first-time setup: secrets, build, start
#   ./deploy.sh up          start (or restart) the stack
#   ./deploy.sh down        stop the stack, keep data
#   ./deploy.sh restart     restart without rebuilding
#   ./deploy.sh rebuild     rebuild images and restart
#   ./deploy.sh logs [svc]  follow logs
#   ./deploy.sh status      container + health status
#   ./deploy.sh ports       print the ports to whitelist
#   ./deploy.sh firewall    apply the firewall rules (ufw / firewalld)
#   ./deploy.sh env         show the resolved configuration
#   ./deploy.sh backup      dump the database
#   ./deploy.sh destroy     stop and DELETE all data (asks twice)
#
# Everything is driven by `.env` in the repo root. Run `./deploy.sh install`
# once and it writes that file for you with generated secrets.
# ─────────────────────────────────────────────────────────────
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

ENV_FILE="$SCRIPT_DIR/.env"
ENV_EXAMPLE="$SCRIPT_DIR/deploy/env.production.example"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"

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

trap 'die "failed at line $LINENO — see the message above"' ERR

# ── compose wrapper ──────────────────────────────────────────
# Prefer the v2 plugin, fall back to docker-compose v1.
compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
  else
    die "Docker Compose is not installed. Install the docker compose plugin."
  fi
}

# ── .env loading ─────────────────────────────────────────────
# Sourced so the script can read the same values Compose will use. The file is
# written by this script and contains only KEY=value lines.
load_env() {
  [ -f "$ENV_FILE" ] || die "No .env found. Run: ./deploy.sh install"
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
}

env_get() {
  # env_get KEY DEFAULT — reads from the loaded environment.
  local key="$1" def="${2:-}"
  local val="${!key:-}"
  printf '%s' "${val:-$def}"
}

# ── preflight ────────────────────────────────────────────────
preflight() {
  command -v docker >/dev/null 2>&1 \
    || die "Docker is not installed. See https://docs.docker.com/engine/install/"

  docker info >/dev/null 2>&1 \
    || die "Cannot talk to the Docker daemon. Are you root, or in the 'docker' group?"

  if ! docker compose version >/dev/null 2>&1 && ! command -v docker-compose >/dev/null 2>&1; then
    die "Docker Compose is not installed."
  fi

  # Used to render the coturn config from its template.
  command -v envsubst >/dev/null 2>&1 \
    || die "envsubst is missing. Install gettext: apt-get install -y gettext-base"

  # Used to generate secrets.
  command -v openssl >/dev/null 2>&1 \
    || die "openssl is missing. Install it: apt-get install -y openssl"

  # mediasoup needs a modern kernel for its UDP sockets; anything older than
  # 4.x will fail in ways that are hard to diagnose.
  local kver
  kver="$(uname -r | cut -d. -f1)"
  [ "${kver:-0}" -ge 4 ] || warn "Kernel $(uname -r) is old — mediasoup may misbehave."

  # The SFU is CPU-bound per stream. Warn rather than refuse.
  local cores
  cores="$(nproc 2>/dev/null || echo 1)"
  if [ "$cores" -lt 4 ]; then
    warn "Only ${cores} CPU core(s). A 500-person webinar wants 8+."
  fi
}

# ── public IP detection ──────────────────────────────────────
detect_public_ip() {
  local ip=""
  # Several providers because any single one can be blocked or rate-limited.
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
  # 48 bytes of base64, stripped of characters that would need quoting in .env.
  openssl rand -base64 48 2>/dev/null | tr -d '\n=+/' | cut -c1-"${1:-48}" \
    || head -c 64 /dev/urandom | base64 | tr -d '\n=+/' | cut -c1-"${1:-48}"
}

# ── port plan ────────────────────────────────────────────────
# Single source of truth for what gets opened. `ports` and `firewall` both
# read from here, so the printed list can never drift from what is applied.
print_ports() {
  load_env

  local http_port api_port web_port
  local rtc_min rtc_max turn_port turn_tls turn_min turn_max
  local pg_port redis_port

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
  redis_port="$(env_get REDIS_PORT 6379)"

  local rtc_count=$(( rtc_max - rtc_min + 1 ))
  # One port per WebRTC transport, two transports per peer.
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
  printf '  %-22s %-10s %s\n' "$pg_port" "tcp" "PostgreSQL"
  printf '  %-22s %-10s %s\n' "$redis_port" "tcp" "Redis"
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
  printf '%s\n' "${DIM}Or let this script do it:${R}  ./deploy.sh firewall"
  hr
}

# ── firewall ─────────────────────────────────────────────────
apply_firewall() {
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
    ufw allow "$http_port"/tcp            >/dev/null
    ufw allow "$rtc_min:$rtc_max"/udp     >/dev/null
    ufw allow "$rtc_min:$rtc_max"/tcp     >/dev/null
    ufw allow "$turn_port"                >/dev/null
    ufw allow "$turn_tls"/tcp             >/dev/null
    ufw allow "$turn_min:$turn_max"/udp   >/dev/null
    ok "ufw rules applied"
    ufw status numbered | sed 's/^/  /'
  elif command -v firewall-cmd >/dev/null 2>&1; then
    info "Applying firewalld rules…"
    firewall-cmd --permanent --add-port="$http_port"/tcp          >/dev/null
    firewall-cmd --permanent --add-port="$rtc_min-$rtc_max"/udp   >/dev/null
    firewall-cmd --permanent --add-port="$rtc_min-$rtc_max"/tcp   >/dev/null
    firewall-cmd --permanent --add-port="$turn_port"/udp          >/dev/null
    firewall-cmd --permanent --add-port="$turn_port"/tcp          >/dev/null
    firewall-cmd --permanent --add-port="$turn_tls"/tcp           >/dev/null
    firewall-cmd --permanent --add-port="$turn_min-$turn_max"/udp >/dev/null
    firewall-cmd --reload >/dev/null
    ok "firewalld rules applied"
    firewall-cmd --list-ports | tr ' ' '\n' | sed 's/^/  /'
  else
    warn "Neither ufw nor firewalld found — apply the rules from './deploy.sh ports' manually."
    warn "Remember to also open these in your cloud provider's security group."
    return 0
  fi

  printf '\n'
  warn "Host firewall done. You STILL need to open the same ports in the"
  warn "cloud provider's security group (AWS SG / GCP firewall / Hetzner / DO)."
}

# ── template rendering ───────────────────────────────────────
render_templates() {
  load_env

  info "Rendering nginx and coturn configuration…"

  render_nginx

  # coturn: rendered by us because the image has no envsubst step.
  local tpl="$SCRIPT_DIR/infra/coturn/turnserver.conf.template"
  local out="$SCRIPT_DIR/infra/coturn/turnserver.conf"
  [ -f "$tpl" ] || die "Missing $tpl"

  # Only substitute the variables we own, so coturn's own $ syntax survives.
  local vars='$PUBLIC_IP $TURN_PORT $TURN_TLS_PORT $TURN_REALM $TURN_USERNAME $TURN_PASSWORD $TURN_MIN_PORT $TURN_MAX_PORT'
  envsubst "$vars" < "$tpl" > "$out"
  chmod 600 "$out"
  ok "coturn config rendered"
}

# nginx only ever speaks plain HTTP here. TLS is terminated by the Caddy
# instance on the VPS, which forwards to HTTP_PORT. So there is nothing to
# choose between and no certificates to mount — just substitute the ports.
render_nginx() {
  local tpl="$SCRIPT_DIR/infra/nginx/templates/default.conf.template"
  local outdir="$SCRIPT_DIR/infra/nginx/rendered"
  local out="$outdir/default.conf"
  [ -f "$tpl" ] || die "Missing $tpl"

  mkdir -p "$outdir"

  local vars='${HTTP_PORT} ${SERVER_NAME} ${API_PORT} ${WEB_PORT}'
  envsubst "$vars" < "$tpl" > "$out"

  ok "nginx config rendered (plain HTTP on port $(env_get HTTP_PORT 5173))"
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

    # TLS is terminated by Caddy on the VPS, not by this stack. So the public
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

    local jwt admin_pw pg_pw turn_pw
    jwt="$(gen_secret 48)"
    admin_pw="$(gen_secret 20)"
    pg_pw="$(gen_secret 32)"
    turn_pw="$(gen_secret 32)"

    [ -f "$ENV_EXAMPLE" ] || die "Missing $ENV_EXAMPLE"

    # Start from the documented example so every key is present, then override
    # the ones that must be unique to this deployment.
    cp "$ENV_EXAMPLE" "$ENV_FILE"

    set_env() {
      local key="$1" val="$2"
      # Replace the line if present, append otherwise. `|` as the delimiter
      # because secrets can contain `/`.
      if grep -qE "^${key}=" "$ENV_FILE"; then
        # Escape characters that are special to sed's replacement.
        local esc
        esc="$(printf '%s' "$val" | sed -e 's/[&|\\]/\\&/g')"
        sed -i "s|^${key}=.*|${key}=${esc}|" "$ENV_FILE"
      else
        printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
      fi
    }

    set_env PUBLIC_IP "$public_ip"
    set_env MEDIASOUP_ANNOUNCED_IP "$public_ip"
    set_env SERVER_NAME "$domain"
    set_env WEB_ORIGIN "$web_origin"
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

  render_templates

  info "Building images (this takes several minutes on a fresh host)…"
  compose build

  info "Starting the stack…"
  compose up -d

  info "Waiting for the API to become healthy…"
  wait_healthy || warn "The stack is up but the API is not answering yet — check './deploy.sh logs server'."

  printf '\n'
  ok "Deployment complete."
  printf '\n'
  print_ports
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
  warn "Check the logs:  ./deploy.sh logs server"
  return 1
}

# ── commands ─────────────────────────────────────────────────
cmd_up() {
  preflight
  load_env
  render_templates
  compose up -d
  wait_healthy || true
}

cmd_down() {
  load_env
  compose down
  ok "Stack stopped (data volumes preserved)"
}

cmd_restart() {
  load_env
  render_templates
  compose restart
  wait_healthy || true
}

cmd_rebuild() {
  preflight
  load_env
  render_templates
  compose build --pull
  compose up -d
  wait_healthy || true
}

cmd_logs() {
  load_env
  if [ -n "${1:-}" ]; then
    compose logs -f --tail=200 "$1"
  else
    compose logs -f --tail=200
  fi
}

cmd_status() {
  load_env
  compose ps
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
  # Never print secrets in full.
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
  load_env
  local dir="$SCRIPT_DIR/backups"
  mkdir -p "$dir"
  local stamp
  stamp="$(date +%Y%m%d-%H%M%S)"
  local out="$dir/webinar-${stamp}.sql"

  info "Dumping database…"
  compose exec -T postgres \
    pg_dump -U "$(env_get POSTGRES_USER webinar)" "$(env_get POSTGRES_DB webinar)" > "$out"
  gzip -f "$out"
  ok "Backup written: ${out}.gz ($(du -h "${out}.gz" | cut -f1))"
}

cmd_destroy() {
  load_env
  warn "This deletes the database, recordings and all uploaded data."
  read -rp "  Type 'destroy' to confirm: " a
  [ "$a" = "destroy" ] || die "Aborted."
  read -rp "  Are you absolutely sure? [y/N]: " b
  [ "${b,,}" = "y" ] || die "Aborted."
  compose down -v
  ok "Stack and volumes removed"
}

usage() {
  cat <<EOF
${B}Webinar platform — deployment${R}

  ./deploy.sh install     First-time setup: generate .env, build, start
  ./deploy.sh up          Start or restart the stack
  ./deploy.sh down        Stop the stack (keeps data)
  ./deploy.sh restart     Restart containers without rebuilding
  ./deploy.sh rebuild     Rebuild images and restart
  ./deploy.sh logs [svc]  Follow logs (server, web, nginx, postgres, coturn)
  ./deploy.sh status      Container and health status
  ./deploy.sh ports       Print the ports to whitelist
  ./deploy.sh firewall    Apply firewall rules (ufw / firewalld)
  ./deploy.sh env         Show the resolved configuration (secrets masked)
  ./deploy.sh backup      Dump the database to ./backups
  ./deploy.sh destroy     Stop and delete all data

${DIM}Configuration lives in .env — see deploy/env.production.example.${R}
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

# Running the platform — complete setup and operations guide

This is the end-to-end runbook: what to install, what to configure, how to start
each piece, how to verify it works, and what to do when it does not.

If you only want the short version, see [Quick start](#2-quick-start-tldr) below.
Everything after that is the detail behind each step.

---

## Table of contents

1. [What you are running](#1-what-you-are-running)
2. [Quick start (TL;DR)](#2-quick-start-tldr)
3. [Prerequisites](#3-prerequisites)
4. [Install](#4-install)
5. [Configuration — every environment variable](#5-configuration--every-environment-variable)
6. [Database setup](#6-database-setup)
7. [Running in development](#7-running-in-development)
8. [First-run walkthrough](#8-first-run-walkthrough)
9. [Running in production (no Docker)](#9-running-in-production-no-docker)
10. [Running with Docker Compose](#10-running-with-docker-compose)11. [WebRTC networking — the part that actually breaks](#11-webrtc-networking--the-part-that-actually-breaks)
12. [Optional integrations](#12-optional-integrations)
13. [Verification suites](#13-verification-suites)
14. [Ports and URLs reference](#14-ports-and-urls-reference)
15. [Troubleshooting](#15-troubleshooting)
16. [Operational tasks](#16-operational-tasks)

---

## 1. What you are running

Three processes, two of them long-lived:

| Process | Package | Port | What it does |
|---|---|---|---|
| **API + SFU** | `@webinar/server` | `4000` | Express REST API, Socket.IO signalling, mediasoup worker pool, Prisma database access, reminder scheduler |
| **Web client** | `@webinar/web` | `3000` | Next.js 15 App Router — landing page, webinar pages, live room, replay, admin console |
| **Shared types** | `@webinar/shared` | — | TypeScript interfaces consumed **from source** by both. No build step, no watch task. |

The web client never talks to mediasoup directly. It exchanges SDP-shaped
parameters with the API over Socket.IO, and the API holds the only authoritative
view of who may publish and who may consume. That is why the API process is also
the media server — they cannot be split without adding a signalling bus.

```
browser ──► Next.js :3000 ──► Express :4000 ──► Prisma ──► SQLite / PostgreSQL
                  │                  │
                  └── Socket.IO ─────┴──► mediasoup workers ──► UDP 40000-40100
```

---

## 2. Quick start (TL;DR)

For a developer machine with Node 20+ and nothing else installed:

```bash
# 1. Install dependencies (also fetches the mediasoup native worker)
npm install

# 2. Create the environment file
cp .env.example .env
#    then edit .env and set JWT_SECRET to something long and random

# 3. Create the SQLite schema and seed demo data
npm run db:push
npm run db:seed

# 4. Start both apps
npm run dev
```

Then open:

- **Landing page** — <http://localhost:3000>
- **Admin console** — <http://localhost:3000/admin/login>
- **API health** — <http://localhost:4000/api/health>

Sign in with `admin@webinar.local` / `Admin@12345`.

That is a complete working install. Media works between two tabs on the same
machine with no extra configuration, because `MEDIASOUP_ANNOUNCED_IP=127.0.0.1`
is correct for localhost. **It is not correct for anything else** — see
[WebRTC networking](#11-webrtc-networking--the-part-that-actually-breaks).

### Deploying to a Linux VPS

On a fresh server with Docker installed, from the repo root:

```bash
./deploy.sh install     # generates secrets, builds, starts, prints the ports
./deploy.sh ports       # the whitelist, any time
./deploy.sh firewall    # apply it with ufw or firewalld
```

See [Running with Docker Compose](#10-running-with-docker-compose) for the full
subcommand list and the port table.

---

## 3. Prerequisites

### Required

| Requirement | Version | Why |
|---|---|---|
| **Node.js** | **20 or newer** (22 LTS recommended) | `package.json` declares `"engines": { "node": ">=20" }`. Next.js 15 and Prisma 6 both require it. |
| **npm** | 10 or newer | The repo is an **npm workspaces** monorepo. pnpm and yarn are not configured and will not resolve `@webinar/shared`. |
| **A C++ toolchain** | — | Only if the prebuilt mediasoup worker cannot be downloaded. See [mediasoup worker](#mediasoup-worker-binary). |

Check your versions:

```bash
node -v      # must be >= 20
npm -v       # must be >= 10
```

### Required for production only

| Requirement | Why |
|---|---|
| **PostgreSQL 14+** | SQLite is fine for development but serialises writes and has no concurrent-writer story. |
| **A public IP or a TURN server** | Without one of these, WebRTC only works on the same LAN. |
| **FFmpeg** | Only for recording media muxing. Without it, recordings are still created with `mediaKind: "none"` and the timeline replay still works. |

### Not required

- **Docker** — the whole stack runs natively. Docker is one of two deployment options.
- **Redis** — `docker-compose.yml` starts one, but the application does not use it. It is there for a future multi-instance deployment.
- **A camera or microphone** — the room works as a viewer without either. See [No camera or microphone](#no-camera-or-microphone).

---

## 4. Install

```bash
git clone <your-repo-url> customwebinar
cd customwebinar
npm install
```

`npm install` does three things beyond the usual:

1. **Installs all three workspaces** (`packages/shared`, `apps/server`, `apps/web`) into a single hoisted `node_modules` at the repo root.
2. **Runs `apps/server/scripts/fetch-mediasoup-worker.mjs`** as a `postinstall` step. mediasoup ships a prebuilt native binary per platform; its own download can fail silently behind a proxy, leaving the package installed but unusable. This script checks for the binary and fetches it directly from GitHub releases if it is missing.
3. **Generates the Prisma client** into `node_modules/.prisma/client`.

### mediasoup worker binary

Verify it exists after install:

```bash
# Linux / macOS
ls node_modules/mediasoup/worker/out/Release/mediasoup-worker

# Windows
dir node_modules\mediasoup\worker\out\Release\mediasoup-worker.exe
```

If it is missing, run the fetch script manually:

```bash
node apps/server/scripts/fetch-mediasoup-worker.mjs
```

If that also fails, you need to build it from source. That requires Python 3,
`make`, and `g++` (Linux/macOS) or the **Desktop development with C++** workload
from Visual Studio Build Tools (Windows). Then:

```bash
npm rebuild mediasoup
```

**Symptom of a missing worker:** the API starts, then exits with
`Error: spawn .../mediasoup-worker ENOENT` or `mediasoup-worker exited with code 1`.

### Behind a corporate proxy

`npm` honours `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`. Node's global `fetch`
does **not** — so any download performed by a script must go through `curl` or an
explicit proxy agent. The mediasoup fetch script uses `curl` for exactly this
reason.

If Prisma's engine download fails with a certificate error, the proxy is
intercepting TLS. As a last resort for a local dev machine only:

```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 npx prisma generate
```

Never do that in production.

---

## 5. Configuration — every environment variable

### Where the file goes

The repo reads `.env` from **three** places, and they are not interchangeable:

| File | Read by | Purpose |
|---|---|---|
| `.env` (repo root) | `npm run dev` at the root, Docker Compose | The canonical file. Start here. |
| `apps/server/.env` | The API process (`dotenv/config` in `config/env.ts`) | Needed if you run the server workspace directly. |
| `apps/web/.env.local` | Next.js | Needed if you run the web workspace directly. Only `NEXT_PUBLIC_*` values matter here. |

**The simplest correct setup is to copy the same file to all three locations.**
The values are identical; only the consumer differs. `npm run dev` from the root
starts both workspaces, and each one loads its own file — so a root-only `.env`
will leave the web client without `NEXT_PUBLIC_API_URL`.

```bash
cp .env.example .env
cp .env.example apps/server/.env
cp .env.example apps/web/.env.local
```

### Validation

`apps/server/src/config/env.ts` parses the environment with Zod at startup. An
invalid value prints the field errors and **exits with code 1** before the server
listens. This is deliberate: a server that starts with a broken config fails
later, in a place that is much harder to diagnose.

### Variable reference

#### Core

| Variable | Default | Required | Notes |
|---|---|---|---|
| `NODE_ENV` | `development` | No | `development` \| `production` \| `test`. Anything else is a startup error. |
| `PORT` | `4000` | No | API listen port. Must match `NEXT_PUBLIC_API_URL`. |
| `WEB_ORIGIN` | `http://localhost:3000` | **Yes in production** | CORS allow-list. **Comma-separated** for multiple origins: `https://a.com,https://b.com`. Used by both Express CORS and Socket.IO. A wrong value here is the single most common cause of "the room connects but nothing happens". |
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000` | **Yes** | Base URL the browser uses for REST. **Inlined at build time** — changing it requires a rebuild, not a restart. |
| `NEXT_PUBLIC_SOCKET_URL` | falls back to `NEXT_PUBLIC_API_URL` | No | Base URL for Socket.IO. Set it separately only if signalling is on a different host. |

#### Database

| Variable | Default | Required | Notes |
|---|---|---|---|
| `DATABASE_URL` | `file:./dev.db` | **Yes** | SQLite path (relative to `apps/server/prisma/`) or a PostgreSQL URL. |

SQLite (development):

```env
DATABASE_URL="file:./dev.db"
```

PostgreSQL (production) — **also change the provider** in
`apps/server/prisma/schema.prisma` from `sqlite` to `postgresql`:

```env
DATABASE_URL="postgresql://webinar:webinar@localhost:5432/webinar?schema=public"
```

#### Auth

| Variable | Default | Required | Notes |
|---|---|---|---|
| `JWT_SECRET` | `dev-only-insecure-secret-change-me` | **Yes in production** | Minimum 16 characters; use 32+. Every session token is signed with it. Changing it signs everyone out. |
| `JWT_EXPIRES_IN` | `7d` | No | Any `jsonwebtoken` duration string (`1h`, `30d`). |
| `ADMIN_EMAIL` | `admin@webinar.local` | No | The seeded admin's email. Read by `prisma/seed.ts`. |
| `ADMIN_PASSWORD` | `Admin@12345` | **Yes in production** | The seeded admin's password. **Change it before exposing the console.** |

Generate a secret:

```bash
openssl rand -hex 32
```

#### Razorpay (optional)

| Variable | Default | Notes |
|---|---|---|
| `RZP_KEY_ID` | empty | Leave blank for mock payments. |
| `RZP_KEY_SECRET` | empty | Leave blank for mock payments. |
| `RZP_WEBHOOK_SECRET` | empty | Required for signature-verified webhooks. |
| `NEXT_PUBLIC_RZP_KEY_ID` | empty | The **public** key id, inlined into the browser bundle. Must equal `RZP_KEY_ID`. |

**Mock mode.** With `RZP_KEY_ID` and `RZP_KEY_SECRET` both blank, the payments
module runs in mock mode: `POST /api/payments/order` returns `mock: true`, and
`verifySignature` accepts any signature of the form `mock_<orderId>`. The whole
checkout flow — order, verify, enrolment, confirmation email — works end to end
without a Razorpay account. This is the correct setting for development.

#### mediasoup / WebRTC

| Variable | Default | Required | Notes |
|---|---|---|---|
| `PUBLIC_IP` | `127.0.0.1` | **Yes in production** | The server's public IP. |
| `MEDIASOUP_ANNOUNCED_IP` | `127.0.0.1` | **Yes in production** | The IP mediasoup advertises in ICE candidates. **This is the value that must be reachable from the browser.** See [WebRTC networking](#11-webrtc-networking--the-part-that-actually-breaks). |
| `RTC_MIN_PORT` | `40000` | No | Start of the UDP/TCP media port range. |
| `RTC_MAX_PORT` | `40100` | No | End of the range. **This is the capacity knob.** Each peer uses 2 transports (send + recv) and each transport takes 1 port, so concurrent peers ≈ `(RTC_MAX_PORT - RTC_MIN_PORT + 1) / 2`. The default 100-port range therefore caps a room at **~50 peers**. The range is shared by *all* workers — raising `MEDIASOUP_WORKERS` does **not** add capacity. For 500 peers set `RTC_MAX_PORT=42000` (2000 ports). |
| `MEDIASOUP_WORKERS` | `2` | No | Worker processes. One worker per CPU core is a reasonable ceiling. Each worker is a separate router namespace. This affects throughput, not peer capacity. |

#### TURN (optional but required for restrictive networks)

| Variable | Default | Notes |
|---|---|---|
| `TURN_URL` | empty | e.g. `turn:turn.example.com:3478`. |
| `TURN_USERNAME` | empty | |
| `TURN_PASSWORD` | empty | |

When all three are set, they are returned by `GET /api/rtc-config` and used as
ICE servers. Without TURN, peers behind symmetric NAT or a corporate firewall
cannot connect. See [TURN](#turn--when-peers-cannot-connect).

#### Email (optional)

Three transports, chosen in this order:

1. `SMTP_HOST` set → plain SMTP, any provider.
2. `RESEND_API_KEY` set → Resend over SMTP.
3. Neither → messages are written to the server log instead of sent.

| Variable | Default | Notes |
|---|---|---|
| `SMTP_HOST` | empty | Wins over `RESEND_API_KEY` when both are set. |
| `SMTP_PORT` | `587` | |
| `SMTP_USER` | empty | |
| `SMTP_PASSWORD` | empty | |
| `RESEND_API_KEY` | empty | |
| `EMAIL_FROM` | `webinars@example.com` | The `From:` address. Must be a verified sender with your provider. |

Mail is **always best-effort**. A send failure is logged and swallowed, because a
mail outage must never fail a registration or roll back a payment that already
succeeded. In development, leaving all of these blank is correct — you will see
the message bodies in the API log.

#### Reminders

| Variable | Default | Notes |
|---|---|---|
| `REMINDERS_ENABLED` | `true` | Set to the literal string `false` to disable the scheduler. |

The scheduler runs every 60 seconds and emails registrants 24 hours, 1 hour, and
10 minutes before a webinar starts. Each `(webinar, lead)` pair is sent at most
once per process — so a restart can re-send a reminder that already went out.

---

## 6. Database setup

### Create the schema

```bash
npm run db:push
```

This runs `prisma db push --skip-generate && prisma generate` in the server
workspace. It creates the SQLite file (or applies the schema to PostgreSQL) and
regenerates the typed client.

`db push` is used rather than `migrate deploy` because the project has no
migration history — the schema is the source of truth. For a production
deployment you should adopt migrations:

```bash
cd apps/server
npx prisma migrate dev --name init     # creates prisma/migrations/
npx prisma migrate deploy              # applies them in CI/production
```

### Seed demo data

```bash
npm run db:seed
```

Creates:

| Thing | Value |
|---|---|
| Admin user | `admin@webinar.local` / `Admin@12345` (role `ADMIN`) |
| Host user | `host@webinar.local` / `Host@12345` (role `HOST`) |
| Moderator user | `mod@webinar.local` / `Mod@12345` (role `MODERATOR`) |
| Course | `course-fullstack-mastery` — "Full-Stack Product Engineering", ₹4,999 |
| Webinar | `live-product-teardown`, status `LIVE`, with quizzes, polls, and two CTAs |

The seed is idempotent — it uses `upsert` throughout, so re-running it will not
duplicate anything. It **will** reset the admin password to `ADMIN_PASSWORD`.

### Inspect the data

```bash
npm run db:studio
```

Opens Prisma Studio at <http://localhost:5555>.

### Reset the demo webinar

`verify-moderation.mjs` ends the demo webinar as its final check, which makes the
next run fail at registration. Restore it with:

```bash
npm run verify:reset
```

### Prisma client regeneration and file locks

On Windows, `prisma generate` fails with `EPERM` if the API server is holding the
client DLL. Stop the server first:

```bash
# find the process on :4000
netstat -ano | grep ":4000" | grep LISTENING
taskkill //PID <pid> //F

cd apps/server
npx prisma db push --skip-generate
npx prisma generate
```

Check for a **second** dev server holding the port — a stale `tsx watch` from an
earlier session is a common cause of `EADDRINUSE`.

---

## 7. Running in development

### Both apps together

```bash
npm run dev
```

Uses `concurrently` to run the API and the web client with colour-coded,
prefixed output. `Ctrl+C` stops both.

### One at a time

```bash
npm run dev:server    # API + SFU only, tsx watch (restarts on save)
npm run dev:web       # Next.js dev server only, HMR
```

Useful when you are only touching one side and want clean logs.

### What "working" looks like

```
[server] API + realtime listening on http://localhost:4000
[server] mediasoup worker 0 ready
[server] mediasoup worker 1 ready
[web]    ▲ Next.js 15.5.x
[web]    - Local:  http://localhost:3000
```

Confirm the API independently:

```bash
curl http://localhost:4000/api/health
# {"ok":true,"uptime":12.4,"workers":2,"rooms":0}
```

`workers` is the mediasoup worker pool size and `rooms` is the number of live
rooms. **If `workers` is `0`, the SFU did not start** and no media will flow.

### Development gotchas

- **`reactStrictMode: true`** is on. In development every effect runs twice. The
  room's join is guarded by a ref, but you will see doubled network requests in
  the Network tab. That is expected.
- **HMR reloads the page on every source edit.** A reload closes every
  `RTCPeerConnection` and destroys every producer. If you are testing media,
  re-establish camera and screen share after each edit.
- **Never run `npm run build -w @webinar/web` while `next dev` is running.** They
  fight over `.next/`.
- **`@webinar/shared` is consumed from source** (`main`/`types`/`exports` all
  point at `./src/index.ts`). Editing it needs no rebuild — but the API's
  `tsx watch` and Next's HMR both need to pick up the change, so save the file
  and let them restart.

---

## 8. First-run walkthrough

A five-minute path that exercises the whole system.

### 1. Sign in to the console

Go to <http://localhost:3000/admin/login> and sign in as
`admin@webinar.local` / `Admin@12345`.

You land on the console: a sidebar of webinars, and per-webinar tabs for
Registrations, Engagement, Recordings, Payments, and the eleven feature panels
(Custom fields, Approval, Co-hosts, Streams, Webhooks, Series, Embed, Analytics,
Automation, API tokens).

### 2. Open the demo webinar

Click **Join room** on `live-product-teardown`. You are the host, so you see the
real room immediately — the waiting room only applies to participants.

### 3. Publish media

Use the control bar: **Start video**, **Unmute**, **Share screen**. If you have no
camera, see [No camera or microphone](#no-camera-or-microphone).

### 4. Join as a participant

Open a **second browser profile** (not a second tab — see below) and go to
<http://localhost:3000/w/live-product-teardown>. Register with any name, email,
and phone number. You land in the room and should see the host's camera and
screen share.

> **Two identities need two browser profiles.** The console and the attendee flow
> keep separate tokens (`nexa:admin:token` vs `token`), so a host can register for
> their own webinar in the same browser. But the **room** allows one active socket
> per user — a second tab as the *same* user kicks the first with "You joined from
> another tab or device". Use a private window for the participant.

### 5. Exercise engagement

From the host's **Host tools** drawer: launch a quiz, launch a poll, show a CTA.
The participant sees each one appear in real time. Raise a hand from the
participant side and approve it from the host side — the participant can then
publish their own camera.

### 6. Try the checkout

On the participant's page, click the CTA card. With Razorpay unconfigured you get
mock mode: the order is created, the signature is auto-accepted, and you land on
`/w/live-product-teardown/thanks` with an enrolment recorded.

### 7. Record and replay

**Host tools → Session recording → Start recording**. Chat, quizzes, and offers
are captured on a timeline. Stop it, then open **Admin → Recordings** and watch
the replay at `/replay/<id>` — the clock reconstructs the session.

---

## 9. Running in production (no Docker)

`deploy-native.sh` sets up the whole platform on a bare Linux VPS: Node under
systemd, nginx and coturn from the distro, PostgreSQL from the distro (or SQLite
if you prefer). No containers.

```bash
git clone <your-repo> /opt/webinar && cd /opt/webinar
sudo ./deploy-native.sh install
```

`install` is interactive — it asks for the domain, whether to serve HTTPS, and
which database to use — then does everything else unattended:

1. Checks Node ≥ 20, systemd, `openssl`, `envsubst`, and warns about a missing
   C++ toolchain (mediasoup may need to compile its worker).
2. Detects the public IP and writes `.env` with freshly generated `JWT_SECRET`,
   admin password, Postgres password, and TURN password. Prints the admin
   credentials **once**.
3. Creates the `webinar` system user.
4. Installs and configures PostgreSQL (or points `DATABASE_URL` at SQLite) and
   rewrites the Prisma provider from `sqlite` to `postgresql`.
5. Runs `npm ci`, `prisma generate`, `prisma db push`, the seed, and
   `npm run build` — with `NEXT_PUBLIC_*` exported, so the browser bundle points
   at the right host.
6. Writes `webinar-api.service` and `webinar-web.service`, enables and starts them.
7. Installs nginx, renders `infra/nginx/templates/default.conf.template` into
   `/etc/nginx/sites-available/webinar.conf`, removes the distro's default site,
   and reloads.
8. Installs coturn, renders `infra/coturn/turnserver.conf.template` into
   `/etc/coturn/turnserver.conf`, and enables the service.
9. Polls `/api/health` until the API answers, then prints the port whitelist.

### Subcommands

| Command | What it does |
|---|---|
| `install` | First-time setup, end to end |
| `up` / `down` | Start / stop the API and web services |
| `restart` | Restart without rebuilding |
| `rebuild` | Rebuild and restart (after a code change) |
| `logs [svc]` | Follow logs — `api`, `web`, `nginx`, `coturn` |
| `status` | `systemctl is-active` for all four plus a health probe |
| `ports` | Print the ports to whitelist, with the capacity math |
| `firewall` | Apply the rules via `ufw` or `firewalld` |
| `env` | Show the resolved config with secrets masked |
| `backup` | Dump the database into `./backups/` |
| `destroy` | Remove the units and nginx site (keeps data) |

`ports` and `env` work without root; everything else needs `sudo`.

### What gets installed where

| Thing | Path |
|---|---|
| systemd units | `/etc/systemd/system/webinar-api.service`, `webinar-web.service` |
| nginx site | `/etc/nginx/sites-available/webinar.conf` (symlinked into `sites-enabled`) |
| coturn config | `/etc/coturn/turnserver.conf` (mode 640, group `turnserver`) |
| configuration | `.env` in the repo root (mode 600) |
| logs | `journalctl -u webinar-api` / `-u webinar-web` |

The API unit sets `LimitNOFILE=65535`. mediasoup opens a large UDP range and the
default 1024 fd limit will run out under load.

### Manual build and run (fallback)

If you would rather not use the script, the underlying steps are:

```bash
npm ci
npx prisma generate --schema apps/server/prisma/schema.prisma
npx prisma db push --schema apps/server/prisma/schema.prisma
npx tsx apps/server/prisma/seed.ts
npm run build
npm start
```

`npm run build` compiles the server with `tsc` into `apps/server/dist/` and the
web client with `next build` into `apps/web/.next/` (standalone output).

**`NEXT_PUBLIC_*` values are inlined at build time.** Set them in the environment
*before* running `npm run build`, or the browser bundle will point at the wrong
API host. This is the single most common production mistake.

```bash
export NEXT_PUBLIC_API_URL=https://api.example.com
export NEXT_PUBLIC_SOCKET_URL=https://api.example.com
export NEXT_PUBLIC_RZP_KEY_ID=rzp_live_xxxxxxxx
npm run build
```

`npm start` runs `node dist/index.js` for the API and `next start -p 3000` for the
web client. Neither is supervised — use systemd, pm2, or the script above.

### Production checklist

- [ ] `NODE_ENV=production`
- [ ] `JWT_SECRET` is 32+ random characters, not the default
- [ ] `ADMIN_PASSWORD` is changed from `Admin@12345`
- [ ] `DATABASE_URL` points at PostgreSQL, and the Prisma provider is switched to `postgresql`
- [ ] `WEB_ORIGIN` lists the real web origin(s), comma-separated
- [ ] `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_SOCKET_URL` are the public URLs, set **before** the build
- [ ] `MEDIASOUP_ANNOUNCED_IP` is the server's public IP
- [ ] `RTC_MIN_PORT`–`RTC_MAX_PORT` are open for **both UDP and TCP** in the firewall
- [ ] `TURN_URL` / `TURN_USERNAME` / `TURN_PASSWORD` are set if any user is behind a restrictive NAT
- [ ] `RZP_*` keys are live keys, and `RZP_WEBHOOK_SECRET` matches the Razorpay dashboard
- [ ] `SMTP_*` or `RESEND_API_KEY` is set, and `EMAIL_FROM` is a verified sender
- [ ] Caddy (or another TLS terminator) fronts nginx on `HTTP_PORT` and forwards WebSocket upgrades
- [ ] `prisma migrate deploy` has been run against the production database

### Reverse proxy

The API needs WebSocket upgrades on `/socket.io/` and a long read timeout.
`infra/nginx/templates/default.conf.template` is a working example — both
`deploy.sh` and `deploy-native.sh` render it, so the two paths cannot drift:

```nginx
location /socket.io/ {
    proxy_pass http://webinar_api;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

`$connection_upgrade` comes from a `map` at the top of the file. Do **not**
hardcode `Connection "upgrade"` — that breaks ordinary HTTP requests on the same
server block.

A 60-second default `proxy_read_timeout` will drop idle sockets mid-webinar.

### TLS is Caddy's job, not nginx's

The bundled nginx listens on **plain HTTP only**, on `HTTP_PORT` (5173). It has
no `ssl_certificate`, no ACME webroot, and no `SSL_ENABLED` switch. TLS is
terminated by the Caddy instance on the VPS, which owns 80/443 and forwards to
5173:

```
internet ──443/TLS──> Caddy ──5173/HTTP──> nginx ──> web (3000) / api (4000)
```

A minimal Caddyfile:

```caddy
webinar.example.com {
    reverse_proxy 127.0.0.1:5173
}
```

Caddy obtains and renews the certificate automatically, so there is nothing to
install and no cron job to write. Two things matter:

- **WebSocket upgrades pass through untouched.** Caddy forwards `Upgrade` and
  `Connection` headers by default, so `/socket.io/` works without extra config.
- **`X-Forwarded-Proto` is set by Caddy.** The nginx template forwards it
  verbatim (`$http_x_forwarded_proto`) instead of overwriting it with `$scheme`,
  so the app sees `https` even though the hop into nginx is plain HTTP. It also
  trusts `127.0.0.1`/`::1` via `set_real_ip_from` so `X-Real-IP` is the real
  visitor, not Caddy.

Because Caddy is on the same host, `HTTP_PORT` should stay bound to loopback.
If Caddy runs in a container, publish 5173 on `127.0.0.1` only and point Caddy
at `host.docker.internal:5173` (or the host gateway).

---

## 10. Running with Docker Compose

`docker-compose.yml` brings up six services: PostgreSQL, Redis, the API, the web
client, coturn, and nginx. Every published port is a variable, so a deployment
can move a service without editing the file.

### The one-command path

On a fresh Linux VPS, from the repo root:

```bash
./deploy.sh install
```

That script:

1. Checks Docker, the daemon, Compose, the kernel version and the core count.
2. Detects the public IP (or asks for it) and the domain name.
3. Generates `JWT_SECRET`, the admin password, the Postgres password and the
   TURN password with `openssl rand`.
4. Writes `.env` (mode 600) from `deploy/env.production.example`, overriding the
   generated values.
5. Renders `infra/coturn/turnserver.conf` from its template.
6. Builds the images and starts the stack.
7. Polls `GET /api/health` until the API answers.
8. Prints the port whitelist.

The admin password is shown **once**, at the end of step 4. It is stored in
`.env` and never printed again.

### Subcommands

| Command | What it does |
|---|---|
| `./deploy.sh install` | First-time setup: secrets, build, start |
| `./deploy.sh up` | Start or restart the stack |
| `./deploy.sh down` | Stop the stack, keep data |
| `./deploy.sh restart` | Restart containers without rebuilding |
| `./deploy.sh rebuild` | Rebuild images and restart |
| `./deploy.sh logs [svc]` | Follow logs (`server`, `web`, `nginx`, `postgres`, `coturn`) |
| `./deploy.sh status` | Container and health status |
| `./deploy.sh ports` | Print the ports to whitelist |
| `./deploy.sh firewall` | Apply the rules with `ufw` or `firewalld` |
| `./deploy.sh env` | Show the resolved config, secrets masked |
| `./deploy.sh backup` | `pg_dump` into `./backups/` |
| `./deploy.sh destroy` | Stop and delete all data (asks twice) |

### Ports

`./deploy.sh ports` is the authoritative list — it reads `.env` and computes the
capacity from the actual RTC range. The shape of it:

| Port | Proto | Exposure | Purpose |
|---|---|---|---|
| `HTTP_PORT` (5173) | tcp | **loopback** | Web app, API and websocket via nginx. Caddy fronts this. |
| `RTC_MIN_PORT`–`RTC_MAX_PORT` | udp | public | WebRTC media |
| `RTC_MIN_PORT`–`RTC_MAX_PORT` | tcp | public | Media fallback when UDP is blocked |
| `TURN_PORT` (3478) | udp+tcp | public | TURN relay |
| `TURN_TLS_PORT` (5349) | tcp | public | TURN over TLS |
| `TURN_MIN_PORT`–`TURN_MAX_PORT` | udp | public | TURN relay range |
| `API_PORT` (4000) | tcp | **loopback** | API + SFU |
| `WEB_PORT` (3000) | tcp | **loopback** | Next.js |
| `POSTGRES_PORT` (5432) | tcp | **loopback** | PostgreSQL |
| `REDIS_PORT` (6379) | tcp | **loopback** | Redis |

Open the public ones in **both** the host firewall and the cloud provider's
security group. `./deploy.sh firewall` handles the host; the security group is
always manual.

### Networking

`server`, `coturn` and `nginx` run with `network_mode: host`. mediasoup binds one
UDP port per WebRTC transport, so a 500-person room needs ~1000 ports; publishing
a range that wide through Docker's bridge would create one iptables rule per port
and route every media packet through the userland proxy. Host networking lets the
SFU bind the range directly. Postgres, Redis and the web client stay on the
bridge and are reached over loopback.

### What each service does

| Service | Port | Notes |
|---|---|---|
| `postgres` | `127.0.0.1:5432` | Credentials from `.env`. Data in the `pgdata` volume. |
| `redis` | `127.0.0.1:6379` | Started but **not used by the application**. Reserved for a future multi-instance deployment. |
| `server` | host network, `API_PORT` + RTC range | The API and SFU. The RTC range **must** be open or no media flows. |
| `web` | `127.0.0.1:3000` | Next.js standalone server. |
| `coturn` | host network | TURN relay. Config rendered from `infra/coturn/turnserver.conf.template`. |
| `nginx` | host network, `HTTP_PORT` (5173) | Fronts both apps, handles WebSocket upgrades. Plain HTTP only — Caddy on the host terminates TLS and forwards here. Config rendered from `infra/nginx/templates/default.conf.template`. |

### Manual start (without `deploy.sh`)

```bash
cp deploy/env.production.example .env
# edit .env: POSTGRES_PASSWORD, JWT_SECRET, ADMIN_PASSWORD, PUBLIC_IP, SERVER_NAME
docker compose --env-file .env up --build -d
```

The schema and the admin account are applied by the container entrypoint
(`infra/docker/server-entrypoint.sh`) when `RUN_MIGRATIONS=1`, so no `exec` step
is needed. Set `RUN_MIGRATIONS=0` if you would rather run the migration as a
one-off job.

### Before exposing it

1. **Set `PUBLIC_IP` and `MEDIASOUP_ANNOUNCED_IP`** to the host's public IP.
2. **Set `WEB_ORIGIN`** to the public web URL.
3. **Set `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_SOCKET_URL`** — these are build args
   in `infra/docker/web.Dockerfile`, so they must be present at build time.
   Changing them requires `./deploy.sh rebuild`, not a restart.
4. **Widen `RTC_MAX_PORT`** if you expect more than ~50 concurrent peers. See
   [Scale the SFU](#scale-the-sfu).
5. **Set the TURN password** — `./deploy.sh install` generates one; a manual
   setup must not leave `change-me-turn-password` in place.
6. **The Prisma provider is rewritten at build time** from `DATABASE_PROVIDER`,
   so `schema.prisma` can stay on SQLite for local development.

---

## 11. WebRTC networking — the part that actually breaks

Everything else in this guide is ordinary web-app setup. This section is not.

### The one rule

**`MEDIASOUP_ANNOUNCED_IP` must be an IP the browser can actually reach.**

mediasoup puts this value into the ICE candidates it hands to the browser. If it
is wrong, the browser is told to send media to an address that does not exist,
ICE never completes, and the symptom is *"the room loads, the roster is correct,
chat works, but there is no video and no error message."*

| Scenario | `MEDIASOUP_ANNOUNCED_IP` |
|---|---|
| Everything on one machine | `127.0.0.1` (the default — correct) |
| Two machines on the same LAN | The server's LAN IP, e.g. `192.168.1.50` |
| Public internet, server has a public IP | That public IP |
| Public internet, server is behind NAT | The **public** IP, with port forwarding for `40000-40100` |
| Behind a load balancer | The load balancer's public IP |

### Firewall

Open the RTC range for **both** protocols:

```
40000-40100/udp
40000-40100/tcp
```

UDP carries the media. TCP is the fallback when UDP is blocked — without it, a
corporate network that blocks UDP gives you a room with no video.

### TURN — when peers cannot connect

STUN tells a peer its own public address. It cannot help when both peers are
behind symmetric NAT, which is the normal case on corporate networks and mobile
carriers. Those peers need a relay: TURN.

Run coturn (the Compose file includes it), then set:

```env
TURN_URL=turn:turn.example.com:3478
TURN_USERNAME=webinar
TURN_PASSWORD=<the password from turnserver.conf>
```

These are returned by `GET /api/rtc-config` and used as ICE servers by every
transport.

**How to tell you need TURN:** two peers on different networks see each other in
the roster and exchange chat, but `chrome://webrtc-internals` shows the ICE
connection stuck in `checking` and never reaching `connected`.

### Verifying media end to end

1. Open the room in two browser profiles.
2. In each, go to `chrome://webrtc-internals`.
3. Find the peer connection with an active `inbound-rtp` stream.
4. `bytesReceived` should climb steadily. If it stays at zero, ICE failed — check
   `MEDIASOUP_ANNOUNCED_IP` and the firewall first, TURN second.

### No camera or microphone

In a headless VM, a container, or a locked-down desktop, `getUserMedia` throws
`NotFoundError`. The room still works — you join as a viewer, chat and quizzes
function, and you can exercise screen share by stubbing `getDisplayMedia`.

To test the full media path without hardware, override the media APIs before the
app loads:

```js
// In the browser console, before navigating to the room — or via a Playwright
// addInitScript.
window.__canvases = [];   // MUST retain the canvas or the track goes 'ended'
const mk = (label, color) => {
  const c = document.createElement('canvas');
  c.width = 640; c.height = 360;
  window.__canvases.push(c);
  const g = c.getContext('2d');
  let n = 0;
  setInterval(() => {
    g.fillStyle = color; g.fillRect(0, 0, 640, 360);
    g.fillStyle = '#fff'; g.font = '40px sans-serif';
    g.fillText(label + ' ' + (n++), 40, 180);
  }, 100);
  return c.captureStream(15);
};
navigator.mediaDevices.getUserMedia = async (c) => {
  const out = new MediaStream();
  if (c?.video) out.addTrack(mk('CAM', '#1d4ed8').getVideoTracks()[0]);
  return out;
};
navigator.mediaDevices.getDisplayMedia = async () => mk('SCREEN', '#065f46');
```

The `window.__canvases` retention is not optional: a `captureStream()` track dies
when its canvas is garbage-collected, and the symptom is a video element that
reports `videoWidth: 2` and a track in `readyState: 'ended'`.

---

## 12. Optional integrations

### Razorpay

1. Create an account and get the key id and secret from **Settings → API Keys**.
2. Set `RZP_KEY_ID`, `RZP_KEY_SECRET`, and `NEXT_PUBLIC_RZP_KEY_ID` (the same value as `RZP_KEY_ID`).
3. Set `RZP_WEBHOOK_SECRET` and register the webhook URL in the Razorpay dashboard:
   `https://your-api-host/api/payments/webhook`, events `payment.captured` and `payment.failed`.
4. Rebuild the web client — `NEXT_PUBLIC_RZP_KEY_ID` is inlined at build time.

The webhook route is mounted with `express.raw` **before** `express.json`, because
signature verification needs the exact bytes Razorpay sent. Reordering those two
middleware lines silently breaks every webhook.

### Email

Pick one:

```env
# Option A — any SMTP provider
SMTP_HOST=smtp.postmarkapp.com
SMTP_PORT=587
SMTP_USER=your-api-key
SMTP_PASSWORD=your-api-key
EMAIL_FROM=webinars@yourdomain.com

# Option B — Resend
RESEND_API_KEY=re_xxxxxxxxxxxx
EMAIL_FROM=webinars@yourdomain.com
```

Leave both blank in development; message bodies appear in the API log.

### FFmpeg (recording media)

Recording has two independent halves: the **timeline** (always captured) and the
**media** (best-effort MP4 muxing). Without FFmpeg on `PATH`, recordings are still
created with `mediaKind: "none"` and the replay still reconstructs the session
from the timeline — you just get no video.

```bash
ffmpeg -version    # must be on PATH
```

### Webhooks (outbound)

Configured per webinar in the console under **Webhooks**. 14 events, HMAC-signed,
delivered from an outbox with retry and a delivery log. A 4xx response (except
429) is treated as permanent and is not retried.

### Public API

Create a token under **API tokens**. Tokens are stored hashed and shown in
plaintext exactly once. Every path under `/api/v1` uses a uniform envelope:

```json
{ "success": true, "data": { } }
{ "success": false, "error": "message", "details": { } }
```

### Embedding

Configured per webinar under **Embed**. The origin allow-list rejects wildcards.
The public policy endpoint is `GET /api/webinars/:slug/embed-policy`.

---

## 13. Verification suites

The repo ships 28 runtime suites that assert real behaviour over the wire against
a live API. They are the fastest way to confirm an install is healthy.

### Run everything

```bash
npm run verify
```

Runs `node scripts/verify-all.mjs`: every suite in a fixed order, with a summary
and a non-zero exit code on any failure.

### Run one suite

```bash
node scripts/verify-polls.mjs
```

Each suite logs in as the seeded admin, registers a throwaway participant, and
prints `RESULT: PASS` or `RESULT: FAIL`.

### Prerequisites

- **The API must be running on `:4000`.** The suites talk to it directly.
- **Close any browser tab that is in the room.** A tab logged in as the seeded
  admin holds the same single socket slot the suite's host needs, and the suite's
  host is then kicked with "Not in a room".
- **The demo webinar must be `LIVE`.** `npm run verify:reset` restores it.

### What the suites cover

| Group | Suites |
|---|---|
| **Core** | polls, Q&A, quiz + CTA, engagement authoring, guest join, security gates, media requests, waiting room, recording, premiere, screen share, media effects, moderation |
| **webinar.gg parity** | custom fields, approval, invites, co-hosts, webhooks, public API, embed, automation, series, stream destinations, metrics, watermark, chat announcements, participant tabs |
| **Session** | admin session persistence |

`verify-all.mjs` resets the demo webinar after the three suites that leave it
unusable (`verify-moderation`, `verify-premiere`, `verify-waiting-room`). Every
parity suite creates its own fixture webinar and deletes it in a `finally`, so
they are re-runnable and independent of the demo data.

### Typecheck

```bash
npm run typecheck
```

Runs `tsc --noEmit` in both workspaces. Run this before committing — the suites
exercise behaviour, not types.

---

## 14. Ports and URLs reference

### Ports

In development these are fixed. In a Docker deployment every one of them is a
variable in `.env` — run `./deploy.sh ports` for the authoritative list.

| Port | Protocol | Service | Configurable via |
|---|---|---|---|
| `3000` | TCP | Next.js web client | `WEB_PORT` (Docker) / `next dev -p 3000` (dev) |
| `4000` | TCP | Express API + Socket.IO | `API_PORT` (Docker) / `PORT` (dev) |
| `40000-40100` | **UDP + TCP** | mediasoup media | `RTC_MIN_PORT` / `RTC_MAX_PORT` |
| `3478` | UDP/TCP | coturn STUN/TURN | `TURN_PORT` |
| `5349` | TCP | coturn TURNS (TLS) | `TURN_TLS_PORT` |
| `49152-65535` | UDP | coturn relay range | `TURN_MIN_PORT` / `TURN_MAX_PORT` |
| `5555` | TCP | Prisma Studio | `npm run db:studio` |
| `5173` | TCP | nginx (loopback; Caddy fronts it) | `HTTP_PORT` |
| `5432` | TCP | PostgreSQL (Docker only, loopback) | `POSTGRES_PORT` |
| `6379` | TCP | Redis (Docker only, loopback) | `REDIS_PORT` |

**The RTC range is the capacity limit.** 2 ports per peer, shared across all
workers — see [Scale the SFU](#scale-the-sfu).

### Web routes

| Path | What it is |
|---|---|
| `/` | Landing page |
| `/admin/login` | Console sign-in |
| `/admin` | Console (sidebar + 11 feature panels) |
| `/w/<slug>` | Public webinar page — registration, countdown, join |
| `/w/<slug>/pay` | Checkout |
| `/w/<slug>/thanks` | Post-purchase confirmation |
| `/room/<slug>` | The live room |
| `/replay/<recordingId>` | Recording replay |
| `/embed/<slug>` | Iframe embed target |

### API endpoints worth knowing

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/health` | none | Liveness + worker/room counts |
| `GET /api/time` | none | Server clock, for countdown sync |
| `GET /api/rtc-config` | none | ICE servers for the browser |
| `POST /api/auth/login` | none | Issue a JWT (also sets the console cookie) |
| `GET /api/webinars/:slug/public` | none | Public webinar projection |
| `POST /api/webinars/:slug/register` | none | Register (requires `name`, `email`, `phone`) |
| `POST /api/webinars/:slug/guest` | none | Guest join, when `requireRegistration` is off |
| `POST /api/webinars/:slug/host-join` | Bearer | Staff join link |
| `POST /api/payments/order` | Bearer | Create a Razorpay order (or a mock one) |
| `POST /api/payments/verify` | Bearer | Verify a signature and fulfil |
| `POST /api/payments/webhook` | signature | Razorpay webhook (raw body) |
| `/api/admin/*` | Bearer + role | Console surface |
| `/api/v1/*` | Bearer (`nxl_` token) | Public API, `{ success, data }` envelope |

Full detail in [`api.md`](api.md) and [`socket-events.md`](socket-events.md).

---

## 15. Troubleshooting

### The API exits immediately on start

`config/env.ts` validates the environment with Zod and exits with code 1 on
failure. Read the printed field errors. The usual causes are a `JWT_SECRET`
shorter than 16 characters, a malformed `ADMIN_EMAIL`, or a `NODE_ENV` that is
not one of `development` / `production` / `test`.

### `EADDRINUSE` on port 4000

A previous dev server is still running — often a stale `tsx watch`.

```bash
netstat -ano | grep ":4000" | grep LISTENING
taskkill //PID <pid> //F
```

Check for **two** PIDs. A duplicate server is also the usual cause of a Prisma
`EPERM` during `generate`.

### `mediasoup-worker ENOENT` / worker exits with code 1

The native binary is missing or was built for the wrong platform.

```bash
node apps/server/scripts/fetch-mediasoup-worker.mjs
# if that fails:
npm rebuild mediasoup
```

### `/api/health` reports `workers: 0`

The SFU did not start. Check the API log for a worker error — almost always the
missing binary above.

### The room loads but there is no video, and no error

ICE failed. In order of likelihood:

1. `MEDIASOUP_ANNOUNCED_IP` is `127.0.0.1` but the browser is on another machine.
2. Ports `40000-40100` are not open for **UDP** (and TCP).
3. Both peers are behind symmetric NAT and no TURN server is configured.

Confirm with `chrome://webrtc-internals`: the ICE connection stays in `checking`
and `bytesReceived` never climbs.

### "You joined from another tab or device"

The room allows one active socket per user. A second tab as the same user kicks
the first. Use a separate browser profile for a second identity.

### CORS errors in the browser console

`WEB_ORIGIN` does not match the origin the browser is on. It is comma-separated
and must include the scheme and port exactly: `http://localhost:3000`, not
`localhost:3000`.

### The browser calls the wrong API host

`NEXT_PUBLIC_API_URL` is **inlined at build time**. Changing it in `.env` and
restarting is not enough — you must rebuild the web client.

### `prisma generate` fails with `EPERM`

The API server holds the client DLL. Stop it, then regenerate. See
[Prisma client regeneration and file locks](#prisma-client-regeneration-and-file-locks).

### Prisma engine download fails behind a proxy

The proxy is intercepting TLS. For a local dev machine only:

```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 npx prisma generate
```

### A verify suite fails with "Not in a room"

A browser tab logged in as the seeded admin is sitting in the room, holding the
single socket slot the suite's host needs. Close it and re-run.

### A verify suite fails at registration

The demo webinar is `ENDED` — `verify-moderation.mjs` ends it as its final check.
Run `npm run verify:reset`.

### Recordings have no video

FFmpeg is not on `PATH`. The timeline is still captured and the replay still
works; only the MP4 is missing. Install FFmpeg and re-record.

### Emails are not arriving

Check the transport selection order: `SMTP_HOST` wins over `RESEND_API_KEY`, and
if neither is set, mail is only logged. Look for the message body in the API log
to confirm the send was attempted. A send failure is logged and swallowed by
design, so a broken mail config never surfaces as a user-facing error.

### Tailwind reports a class does not exist

Usually a stale `.next` cache, not a real missing class.

```bash
# stop the dev server first
rm -rf apps/web/.next
npm run dev:web
```

### `npm run build -w @webinar/web` fails while `next dev` is running

They share `.next/`. Stop the dev server first.

---

## 16. Operational tasks

### Change the admin password

```bash
# 1. set ADMIN_PASSWORD in .env
# 2. re-run the seed (it upserts and resets the hash)
npm run db:seed
```

### Rotate `JWT_SECRET`

Change the value and restart the API. **Every existing session is invalidated** —
all users must sign in again.

### Back up the database

SQLite:

```bash
cp apps/server/prisma/dev.db "backup-$(date +%F).db"
```

PostgreSQL:

```bash
pg_dump "$DATABASE_URL" > "backup-$(date +%F).sql"
```

### Scale the SFU

The single number that decides how many people fit in a room is the size of the
RTP port range. Everything else is throughput.

**Measured behaviour** (probed directly against mediasoup 3.31, not inferred
from documentation):

| Workers | Port range | Ports | Transports created | Peers |
|---|---|---|---|---|
| 1 | 40000–40099 | 100 | 100 | **50** |
| 2 | 40000–40099 | 100 | 100 | **50** |
| 4 | 40000–40099 | 100 | 100 | **50** |
| 2 | 40000–40999 | 1000 | 1000 | **500** |

Two facts fall out of that table:

1. **One port per transport, two transports per peer.** Every peer creates a
   send transport and a receive transport (`useMediasoup.ts`), so a peer costs
   2 ports even if it never publishes.
2. **The range is a single global resource.** `MEDIASOUP_WORKERS` does not
   partition it. Going from 1 worker to 4 with the same range produced exactly
   the same ceiling. The shipped 100-port default therefore caps a room at
   **~48–50 peers**, and the failure mode is
   `no more available ports [protocol:udp, ip:'0.0.0.0']`.

So:

- **To raise capacity, widen the range.** `RTC_MAX_PORT=42000` gives 2001 ports
  ≈ 1000 peers. That is the setting to change for a 500-person webinar.
- **Raise `MEDIASOUP_WORKERS` for throughput, not capacity.** One worker per
  core spreads encode/decode work; it does not create ports.
- **Create the send transport lazily** if you want to double the ceiling for
  view-only audiences — participants who never publish do not need one. Not
  implemented yet.
- **Egress bandwidth is the next wall.** 500 viewers × ~1 Mbps ≈ 500 Mbps of
  outbound traffic. Check the VPS's bandwidth allowance before the port range.
- **Beyond one machine** you need a multi-instance signalling bus (Redis is
  already in the Compose file for this) and per-room worker affinity. That is
  not implemented — the Socket.IO server has no Redis adapter and no sticky
  sessions, so a second API instance would split rooms.

### Monitor

- `GET /api/health` — `workers` and `rooms`. A `rooms` count that never returns
  to zero after everyone leaves indicates a leaked room.
- The API log — `createLogger(scope)` prefixes every line with its subsystem.
- Webhook delivery log — per endpoint, in the console.

---

## Further reading

- [`architecture.md`](architecture.md) — request and media flows, why an SFU
- [`api.md`](api.md) — every REST endpoint, including the `/api/v1` public API
- [`socket-events.md`](socket-events.md) — the realtime contract and the co-host permission model
- [`media-effects.md`](media-effects.md) — virtual backgrounds and noise cancellation
- [`webinar-gg-parity.md`](webinar-gg-parity.md) — the competitor feature audit

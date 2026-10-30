# Documentation

| Document | Read it when |
|---|---|
| **[running-the-platform.md](running-the-platform.md)** | You are installing, configuring, running, deploying, or debugging the platform. **Start here.** |
| [architecture.md](architecture.md) | You want to understand how the pieces fit together — request flow, media lifecycle, why an SFU. |
| [api.md](api.md) | You are calling the REST API, including the `/api/v1` public API. |
| [socket-events.md](socket-events.md) | You are working on the realtime layer or the co-host permission model. |
| [media-effects.md](media-effects.md) | You are working on virtual backgrounds, noise cancellation, or video presentation. |
| [webinar-gg-parity.md](webinar-gg-parity.md) | You want the competitor feature audit and what closed each gap. |

## The 60-second version

```bash
npm install
cp .env.example .env && cp .env.example apps/server/.env && cp .env.example apps/web/.env.local
npm run db:push && npm run db:seed
npm run dev
```

- Web — <http://localhost:3000>
- Console — <http://localhost:3000/admin/login> (`admin@webinar.local` / `Admin@12345`)
- API health — <http://localhost:4000/api/health>

If `/api/health` reports `workers: 0`, the SFU did not start and no media will
flow. See [Troubleshooting](running-the-platform.md#15-troubleshooting).

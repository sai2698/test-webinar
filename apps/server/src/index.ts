import express from 'express';
import http from 'node:http';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { Server as SocketServer } from 'socket.io';
import { env, allowedOrigins } from './config/env.js';
import { iceServers } from './config/mediasoup.js';
import { logger } from './utils/logger.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { authRouter } from './modules/auth/routes.js';
import {
  adminUsersRouter,
  adminWebinarRouter,
  publicWebinarRouter,
} from './modules/webinars/routes.js';
import { registrationRouter } from './modules/registrations/routes.js';
import { paymentRouter, adminPaymentRouter } from './modules/payments/routes.js';
import { webhookRouter } from './modules/payments/webhook.js';
import {
  adminCourseRouter,
  adminCtaRouter,
  adminQuizRouter,
  adminPollRouter,
  ctaFollowUpRouter,
} from './modules/quizzes/routes.js';
import { registerSocketHandlers } from './realtime/socket.js';
import { workerPool } from './realtime/WorkerPool.js';
import { roomManager } from './realtime/RoomManager.js';
import {
  adminRecordingRouter,
  publicRecordingRouter,
  publicRecordingByIdRouter,
} from './modules/recordings/routes.js';
import { startReminderScheduler, stopReminderScheduler } from './utils/reminders.js';
import { adminCustomFieldRouter } from './modules/customFields/routes.js';
import { adminWebhookRouter } from './modules/webhooks/routes.js';
import {
  startWebhookDispatcher,
  stopWebhookDispatcher,
} from './modules/webhooks/service.js';
import { adminRegistrationRouter } from './modules/registrations/admin.js';
import { adminCohostRouter, cohostPolicyRouter } from './modules/cohosts/routes.js';
import { adminStreamRouter } from './modules/streams/routes.js';
import { adminSeriesRouter } from './modules/series/routes.js';
import { adminApiTokenRouter } from './modules/publicApi/tokens.js';
import { publicApiRouter } from './modules/publicApi/routes.js';
import { adminEmbedRouter, publicEmbedRouter } from './modules/embed/routes.js';
import {
  adminAnalyticsRouter,
  publicAnalyticsRouter,
} from './modules/analytics/routes.js';
import { adminAutomationRouter } from './modules/automation/routes.js';

const app = express();

app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);
app.use(cookieParser());

/* ── Webhook must receive the raw body — mount BEFORE json parser ── */
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }), webhookRouter);

app.use(express.json({ limit: '2mb' }));

/* ── health & time ─────────────────────────────────────────── */
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    workers: workerPool.size,
    rooms: roomManager.all.length,
  });
});

/** Server time for countdown synchronisation (avoids wrong client clocks). */
app.get('/api/time', (_req, res) => {
  res.json({ now: Date.now(), iso: new Date().toISOString() });
});

/** ICE server config for the browser. */
app.get('/api/rtc-config', (_req, res) => {
  res.json({ iceServers: iceServers() });
});

/* ── routes ────────────────────────────────────────────────── */
app.use('/api/auth', authRouter);
app.use('/api/webinars', publicWebinarRouter);
app.use('/api/webinars', registrationRouter);
app.use('/api/webinars', publicRecordingRouter);
app.use('/api/webinars', publicEmbedRouter);
app.use('/api/webinars', publicAnalyticsRouter);
app.use('/api/payments', paymentRouter);
app.use('/api/admin/webinars', adminWebinarRouter);
app.use('/api/admin/users', adminUsersRouter);
// Mounted ahead of the blanket admin routers below: those apply a staff-role
// guard to every path under /api/admin, and a co-host's JWT still says
// PARTICIPANT. This route only needs authentication.
app.use('/api/admin', cohostPolicyRouter);
// Same reasoning: the offer follow-up list is for whoever runs the room, and a
// co-host's token role is still PARTICIPANT. The handler checks membership.
app.use('/api/admin', ctaFollowUpRouter);
app.use('/api/admin', adminQuizRouter);
app.use('/api/admin', adminPollRouter);
app.use('/api/admin', adminCtaRouter);
app.use('/api/admin/courses', adminCourseRouter);
app.use('/api/admin/payments', adminPaymentRouter);
app.use('/api/admin/recordings', adminRecordingRouter);
app.use('/api/recordings', publicRecordingByIdRouter);

/* ── webinar.gg parity ─────────────────────────────────────── */
app.use('/api/admin', adminCustomFieldRouter);
app.use('/api/admin', adminRegistrationRouter);
app.use('/api/admin', adminCohostRouter);
app.use('/api/admin', adminStreamRouter);
app.use('/api/admin', adminSeriesRouter);
app.use('/api/admin', adminEmbedRouter);
app.use('/api/admin', adminAnalyticsRouter);
app.use('/api/admin', adminAutomationRouter);
app.use('/api/admin/webhooks', adminWebhookRouter);
app.use('/api/admin/api-tokens', adminApiTokenRouter);
app.use('/api/v1', publicApiRouter);

app.use(notFoundHandler);
app.use(errorHandler);

/* ── http + socket.io ──────────────────────────────────────── */
const server = http.createServer(app);

const io = new SocketServer(server, {
  cors: { origin: allowedOrigins, credentials: true },
  maxHttpBufferSize: 1e7,
  pingTimeout: 30_000,
  pingInterval: 15_000,
});

registerSocketHandlers(io);

async function bootstrap() {
  try {
    await workerPool.init();
    logger.info(`mediasoup ready with ${workerPool.size} worker(s)`);
  } catch (err) {
    logger.error('mediasoup failed to start — media will not work', err);
  }

  server.listen(env.PORT, () => {
    logger.info(`API + realtime listening on http://localhost:${env.PORT}`);
    logger.info(`Allowed origins: ${allowedOrigins.join(', ')}`);
  });

  startReminderScheduler();
  startWebhookDispatcher();
}

async function shutdown(signal: string) {
  logger.info(`${signal} received — shutting down`);
  stopReminderScheduler();
  stopWebhookDispatcher();
  io.close();
  server.close();
  for (const room of roomManager.all) await room.destroy();
  await workerPool.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

void bootstrap();

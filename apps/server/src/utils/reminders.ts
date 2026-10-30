import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import { createLogger } from './logger.js';
import { sendMail, reminderEmail } from './mail.js';

const log = createLogger('reminders');

/**
 * Reminder scheduler.
 *
 * The guide asks for emails 24h, 1h and 10min before start. Rather than pull
 * in node-cron for three fixed offsets, this ticks once a minute and looks for
 * webinars whose start time falls inside a reminder window that has not been
 * sent yet.
 *
 * "Has not been sent yet" is tracked in memory. That is deliberate: a restart
 * re-sends at most one reminder per webinar, which is a far better failure
 * mode than a database table that silently stops a reminder forever if a
 * single send fails.
 */

const LEADS = [
  { key: '24h', ms: 24 * 60 * 60 * 1000, label: 'Tomorrow' },
  { key: '1h', ms: 60 * 60 * 1000, label: 'In 1 hour' },
  { key: '10m', ms: 10 * 60 * 1000, label: 'In 10 minutes' },
] as const;

/** `${webinarId}:${leadKey}` for every reminder already dispatched. */
const sent = new Set<string>();

/** How far past a lead time we still consider it "due". */
const GRACE_MS = 5 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let running = false;

function joinUrl(slug: string, token: string) {
  return `${env.WEB_ORIGIN}/room/${slug}?token=${encodeURIComponent(token)}`;
}

async function tick() {
  if (running) return;
  running = true;

  try {
    const now = Date.now();
    // Only webinars starting within the widest lead can have a due reminder.
    const horizon = new Date(now + LEADS[0].ms + GRACE_MS);

    const webinars = await prisma.webinar.findMany({
      where: {
        status: { in: ['SCHEDULED', 'LIVE'] },
        startsAt: { gt: new Date(now - GRACE_MS), lte: horizon },
      },
      include: {
        registrations: {
          include: { user: { select: { name: true, email: true } } },
        },
      },
    });

    for (const webinar of webinars) {
      const msUntilStart = webinar.startsAt.getTime() - now;

      for (const lead of LEADS) {
        // Due when we are inside [lead - grace, lead].
        if (msUntilStart > lead.ms || msUntilStart < lead.ms - GRACE_MS) continue;

        const key = `${webinar.id}:${lead.key}`;
        if (sent.has(key)) continue;
        sent.add(key);

        log.info(
          `[reminders] ${lead.key} for "${webinar.title}" → ${webinar.registrations.length} recipients`
        );

        for (const reg of webinar.registrations) {
          const message = reminderEmail({
            name: reg.user.name,
            webinarTitle: webinar.title,
            startsAt: webinar.startsAt,
            timezone: webinar.timezone,
            joinUrl: joinUrl(webinar.slug, reg.joinToken),
            leadLabel: lead.label,
          });
          // Sequential on purpose: a burst of parallel SMTP connections gets
          // rate-limited by most providers.
          await sendMail({ to: reg.user.email, ...message });
        }
      }
    }

    // Drop keys for webinars that have already started so the set cannot grow
    // without bound over a long-running process.
    const liveIds = new Set(webinars.map((w) => w.id));
    for (const key of sent) {
      const [webinarId] = key.split(':');
      if (!liveIds.has(webinarId)) sent.delete(key);
    }
  } catch (err) {
    log.error('[reminders] tick failed', err);
  } finally {
    running = false;
  }
}

export function startReminderScheduler() {
  if (!env.REMINDERS_ENABLED) {
    log.info('[reminders] disabled via REMINDERS_ENABLED=false');
    return;
  }
  if (timer) return;

  // First tick is delayed so it does not compete with server startup.
  timer = setInterval(() => void tick(), 60_000);
  setTimeout(() => void tick(), 15_000);
  log.info('[reminders] scheduler started (24h / 1h / 10m)');
}

export function stopReminderScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

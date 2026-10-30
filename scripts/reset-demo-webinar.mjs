/**
 * Resets the demo webinar back to LIVE so the verification scripts can be
 * re-run. `verify-moderation.mjs` ends the webinar as its final check, which
 * makes the next run fail at registration.
 *
 *   node scripts/reset-demo-webinar.mjs
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const SLUG = 'live-product-teardown';

const webinar = await prisma.webinar.update({
  where: { slug: SLUG },
  data: {
    status: 'LIVE',
    // A LIVE webinar with no start time renders the waiting room, which is
    // correct for a real session but wrong for a demo that is meant to be
    // joinable. `verify-waiting-room.mjs` clears this on purpose, so it has to
    // be restored here.
    startedAt: new Date(),
  },
});

console.log(`reset ${webinar.slug} -> ${webinar.status} (started ${webinar.startedAt?.toISOString()})`);
await prisma.$disconnect();

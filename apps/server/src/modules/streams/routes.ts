import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { asyncHandler, badRequest, notFound } from '../../middleware/error.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { STREAM_PLATFORMS } from '@webinar/shared';
import type { StreamDestination, StreamPlatform } from '@webinar/shared';

export const adminStreamRouter = Router();

adminStreamRouter.use(requireAuth, requireRole('ADMIN', 'HOST'));

/** webinar.gg allows three destinations, one per platform. */
const MAX_DESTINATIONS = 3;

const addSchema = z.object({
  platform: z.enum(STREAM_PLATFORMS as [string, ...string[]]),
  streamKey: z.string().min(1).max(500),
  /** Required for `custom`, ignored otherwise. */
  rtmpUrl: z.string().url().max(500).optional(),
});

/**
 * The ingest URL for each platform.
 *
 * These are the public, documented RTMP endpoints — not secrets. Only the
 * stream key is sensitive, which is why it is the one field that is never
 * returned.
 */
const INGEST_URL: Record<Exclude<StreamPlatform, 'custom'>, string> = {
  youtube: 'rtmp://a.rtmp.youtube.com/live2',
  twitch: 'rtmp://live.twitch.tv/app',
};

function serialize(
  row: {
    id: string;
    platform: string;
    keyHint: string;
    rtmpHost: string | null;
    createdAt: Date;
  },
  editable: boolean
): StreamDestination {
  return {
    id: row.id,
    platform: row.platform as StreamPlatform,
    keyHint: row.keyHint,
    rtmpHost: row.rtmpHost,
    editable,
    createdAt: row.createdAt.toISOString(),
  };
}

/** GET /api/admin/:webinarId/stream-destinations */
adminStreamRouter.get(
  '/:webinarId/stream-destinations',
  asyncHandler(async (req, res) => {
    const webinar = await prisma.webinar.findUnique({
      where: { id: req.params.webinarId },
      select: { status: true },
    });
    if (!webinar) throw notFound('Webinar not found');

    const rows = await prisma.streamDestination.findMany({
      where: { webinarId: req.params.webinarId },
      orderBy: { createdAt: 'asc' },
    });

    // Once the session is live the destination list is frozen: adding a
    // destination mid-stream would need a second encoder and would silently
    // split the audience.
    const editable = webinar.status !== 'LIVE' && webinar.status !== 'ENDED';

    res.json({
      destinations: rows.map((r) => serialize(r, editable)),
      maxDestinations: MAX_DESTINATIONS,
      editable,
    });
  })
);

/**
 * POST /api/admin/:webinarId/stream-destinations
 *
 * The key is stored as given and never returned. `keyHint` is the last four
 * characters, which is enough for a host to tell two keys apart in a list
 * without exposing either.
 */
adminStreamRouter.post(
  '/:webinarId/stream-destinations',
  asyncHandler(async (req, res) => {
    const body = addSchema.parse(req.body);
    const webinarId = req.params.webinarId;

    const webinar = await prisma.webinar.findUnique({
      where: { id: webinarId },
      select: { status: true },
    });
    if (!webinar) throw notFound('Webinar not found');

    if (webinar.status === 'LIVE' || webinar.status === 'ENDED') {
      throw badRequest('Stream destinations cannot be changed once the webinar is live');
    }

    if (body.platform === 'custom' && !body.rtmpUrl) {
      throw badRequest('A custom destination needs an RTMP URL');
    }

    const count = await prisma.streamDestination.count({ where: { webinarId } });
    if (count >= MAX_DESTINATIONS) {
      throw badRequest(`At most ${MAX_DESTINATIONS} destinations are allowed`);
    }

    const existing = await prisma.streamDestination.findUnique({
      where: { webinarId_platform: { webinarId, platform: body.platform } },
    });
    if (existing) {
      throw badRequest(`A ${body.platform} destination already exists`);
    }

    const key = body.streamKey.trim();
    const rtmpHost =
      body.platform === 'custom'
        ? stripKeyFromUrl(body.rtmpUrl!)
        : INGEST_URL[body.platform as Exclude<StreamPlatform, 'custom'>];

    const row = await prisma.streamDestination.create({
      data: {
        webinarId,
        platform: body.platform,
        streamKey: key,
        rtmpUrl: body.platform === 'custom' ? body.rtmpUrl! : null,
        rtmpHost,
        keyHint: key.slice(-4),
      },
    });

    res.status(201).json({ destination: serialize(row, true) });
  })
);

/** DELETE /api/admin/stream-destinations/:id */
adminStreamRouter.delete(
  '/stream-destinations/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.streamDestination.findUnique({
      where: { id: req.params.id },
      include: { webinar: { select: { status: true } } },
    });
    if (!existing) throw notFound('Destination not found');

    if (existing.webinar.status === 'LIVE') {
      throw badRequest('Cannot remove a destination while the webinar is live');
    }

    await prisma.streamDestination.delete({ where: { id: existing.id } });
    res.json({ ok: true });
  })
);

/**
 * GET /api/admin/:webinarId/stream-destinations/ffmpeg
 *
 * The FFmpeg command that pushes the room to every configured destination.
 * Returned as text rather than executed: the encoder has to run somewhere with
 * the media, and handing the host a command they can run on their own box is
 * both simpler and more honest than pretending the server can do it.
 *
 * The key is included here — this is the one place it must be, because the
 * command is useless without it. The response is never cached.
 */
adminStreamRouter.get(
  '/:webinarId/stream-destinations/ffmpeg',
  asyncHandler(async (req, res) => {
    const rows = await prisma.streamDestination.findMany({
      where: { webinarId: req.params.webinarId },
      orderBy: { createdAt: 'asc' },
    });

    if (rows.length === 0) throw badRequest('No stream destinations configured');

    const outputs = rows
      .map((r) => {
        const url = r.platform === 'custom' ? r.rtmpUrl! : INGEST_URL[r.platform as 'youtube' | 'twitch'];
        return `  -f flv "${url}/${r.streamKey}"`;
      })
      .join(' \\\n');

    const command = [
      'ffmpeg -re -i <your-input> \\',
      '  -c:v libx264 -preset veryfast -tune zerolatency -b:v 2500k -maxrate 2500k -bufsize 5000k \\',
      '  -g 50 -c:a aac -b:a 128k -ar 44100 \\',
      outputs,
    ].join('\n');

    res.setHeader('Cache-Control', 'no-store');
    res.json({ command, destinationCount: rows.length });
  })
);

/**
 * Strip a stream key out of a pasted RTMP URL.
 *
 * Hosts routinely paste the whole `rtmp://host/app/KEY` string into the URL
 * field. Keeping the key in `rtmpHost` would leak it through the list endpoint,
 * so it is removed here and the caller is expected to put it in `streamKey`.
 */
function stripKeyFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    // The last path segment of an RTMP URL is conventionally the key.
    if (parts.length > 1) parts.pop();
    parsed.pathname = '/' + parts.join('/');
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}

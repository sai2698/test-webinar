import { Router } from 'express';
import { prisma } from '../../db/prisma.js';
import { asyncHandler, badRequest, notFound } from '../../middleware/error.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import {
  automationBundleSchema,
  validateBundleReferences,
  type AutomationBundleInput,
} from './schema.js';
import type { AutomationBundle, AutomationCue } from '@webinar/shared';

export const adminAutomationRouter = Router();

adminAutomationRouter.use(requireAuth, requireRole('ADMIN', 'HOST'));

function emptyBundle(): AutomationBundle {
  return { version: 1, personas: [], attendance: [], chat: [], qna: [], cues: [] };
}

function parseBundle(json: string): AutomationBundle {
  try {
    const parsed = JSON.parse(json) as Partial<AutomationBundle>;
    if (parsed.version !== 1) return emptyBundle();
    return {
      version: 1,
      personas: parsed.personas ?? [],
      attendance: parsed.attendance ?? [],
      chat: parsed.chat ?? [],
      qna: parsed.qna ?? [],
      cues: parsed.cues ?? [],
    };
  } catch {
    return emptyBundle();
  }
}

function serializeCue(row: {
  id: string;
  kind: string;
  atMs: number;
  payloadJson: string;
  enabled: boolean;
  firedAt: Date | null;
}): AutomationCue {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
  } catch {
    payload = {};
  }

  return {
    id: row.id,
    kind: row.kind as AutomationCue['kind'],
    atMs: row.atMs,
    payload,
    enabled: row.enabled,
    firedAt: row.firedAt?.toISOString() ?? null,
  };
}

/**
 * POST /api/admin/:webinarId/automation/import
 *
 * Replaces the webinar's automation bundle and rebuilds its cue rows.
 *
 * Import is a full replace, not a merge. A rehearsal script is a single
 * artefact — merging two would produce a timeline nobody wrote and nobody can
 * reason about.
 */
adminAutomationRouter.post(
  '/:webinarId/automation/import',
  asyncHandler(async (req, res) => {
    const parsed = automationBundleSchema.safeParse(req.body);

    if (!parsed.success) {
      throw badRequest('Invalid automation bundle', parsed.error.flatten().fieldErrors);
    }

    const bundle: AutomationBundleInput = parsed.data;
    const problems = validateBundleReferences(bundle);
    if (problems.length > 0) {
      throw badRequest('Invalid automation bundle', { references: problems });
    }

    const webinar = await prisma.webinar.findUnique({
      where: { id: req.params.webinarId },
      select: { id: true },
    });
    if (!webinar) throw notFound('Webinar not found');

    await prisma.$transaction([
      prisma.automationCue.deleteMany({ where: { webinarId: webinar.id } }),
      prisma.webinar.update({
        where: { id: webinar.id },
        data: { automationBundleJson: JSON.stringify(bundle) },
      }),
      prisma.automationCue.createMany({
        data: bundle.cues.map((cue) => ({
          webinarId: webinar.id,
          kind: cue.kind,
          atMs: cue.atMs,
          payloadJson: JSON.stringify(cue.payload),
          enabled: true,
        })),
      }),
    ]);

    const cues = await prisma.automationCue.findMany({
      where: { webinarId: webinar.id },
      orderBy: { atMs: 'asc' },
    });

    res.status(201).json({
      bundle,
      cues: cues.map(serializeCue),
      summary: {
        personas: bundle.personas.length,
        chatLines: bundle.chat.length,
        questions: bundle.qna.length,
        cues: bundle.cues.length,
      },
    });
  })
);

/** GET /api/admin/:webinarId/automation/export — the bundle, ready to re-import. */
adminAutomationRouter.get(
  '/:webinarId/automation/export',
  asyncHandler(async (req, res) => {
    const webinar = await prisma.webinar.findUnique({
      where: { id: req.params.webinarId },
      select: { automationBundleJson: true, slug: true },
    });
    if (!webinar) throw notFound('Webinar not found');

    const bundle = parseBundle(webinar.automationBundleJson);

    // A download, not a JSON body — the point of export is to get a file.
    res.setHeader('Content-Type', 'application/json');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="automation-${webinar.slug}.json"`
    );
    res.setHeader('Cache-Control', 'no-store');
    res.send(JSON.stringify(bundle, null, 2));
  })
);

/** GET /api/admin/:webinarId/automation/cues */
adminAutomationRouter.get(
  '/:webinarId/automation/cues',
  asyncHandler(async (req, res) => {
    const webinar = await prisma.webinar.findUnique({
      where: { id: req.params.webinarId },
      select: { automationBundleJson: true },
    });
    if (!webinar) throw notFound('Webinar not found');

    const cues = await prisma.automationCue.findMany({
      where: { webinarId: req.params.webinarId },
      orderBy: { atMs: 'asc' },
    });

    res.json({
      bundle: parseBundle(webinar.automationBundleJson),
      cues: cues.map(serializeCue),
    });
  })
);

/** PATCH /api/admin/automation/cues/:id — enable, disable, or retime one cue. */
adminAutomationRouter.patch(
  '/automation/cues/:id',
  asyncHandler(async (req, res) => {
    const body = req.body as { enabled?: boolean; atMs?: number };

    const existing = await prisma.automationCue.findUnique({
      where: { id: req.params.id },
    });
    if (!existing) throw notFound('Cue not found');

    const cue = await prisma.automationCue.update({
      where: { id: existing.id },
      data: {
        ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
        ...(typeof body.atMs === 'number' && body.atMs >= 0 ? { atMs: body.atMs } : {}),
      },
    });

    res.json({ cue: serializeCue(cue) });
  })
);

/**
 * POST /api/admin/:webinarId/automation/reset
 *
 * Clears every `firedAt` so the same bundle can be replayed. Without this a
 * second rehearsal silently does nothing, because every cue is already marked
 * as fired.
 */
adminAutomationRouter.post(
  '/:webinarId/automation/reset',
  asyncHandler(async (req, res) => {
    const result = await prisma.automationCue.updateMany({
      where: { webinarId: req.params.webinarId },
      data: { firedAt: null },
    });

    res.json({ ok: true, reset: result.count });
  })
);

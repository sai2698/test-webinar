import { Router } from 'express';
import { prisma } from '../../db/prisma.js';
import { asyncHandler, badRequest, notFound } from '../../middleware/error.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import {
  bulkCustomFieldsSchema,
  customFieldOptionSchema,
  customFieldSchema,
  reorderCustomFieldsSchema,
  updateCustomFieldSchema,
} from './schema.js';
import {
  assertFieldUsable,
  listFields,
  nextOrder,
  serializeField,
} from './service.js';

export const adminCustomFieldRouter = Router();

adminCustomFieldRouter.use(requireAuth, requireRole('ADMIN', 'HOST', 'MODERATOR'));

/** GET /api/admin/:webinarId/custom-fields */
adminCustomFieldRouter.get(
  '/:webinarId/custom-fields',
  asyncHandler(async (req, res) => {
    res.json({ fields: await listFields(req.params.webinarId) });
  })
);

/**
 * POST /api/admin/:webinarId/custom-fields
 *
 * Creates one field. `order` defaults to the end of the list, so a host adding
 * fields one at a time gets them in the order they added them.
 */
adminCustomFieldRouter.post(
  '/:webinarId/custom-fields',
  asyncHandler(async (req, res) => {
    const body = customFieldSchema.parse(req.body);
    const webinarId = req.params.webinarId;

    const options = body.options ?? [];
    assertFieldUsable(body.type, options.length);

    const order = body.order ?? (await nextOrder(webinarId));

    const row = await prisma.customField.create({
      data: {
        webinarId,
        label: body.label,
        type: body.type,
        isRequired: body.isRequired,
        placeholder: body.placeholder ?? null,
        defaultValueJson:
          body.defaultValue === undefined ? null : JSON.stringify(body.defaultValue),
        order,
        options: {
          create: options.map((o, i) => ({
            label: o.label,
            value: o.value ?? slugify(o.label),
            order: i,
          })),
        },
      },
      include: { options: { orderBy: { order: 'asc' } } },
    });

    res.status(201).json({ field: serializeField(row) });
  })
);

/**
 * POST /api/admin/:webinarId/custom-fields/bulk
 *
 * Creates several fields in one transaction. Used by the "add all the usual
 * questions" button and by the API, where a client would otherwise make a
 * dozen round trips and leave a half-built form behind on failure.
 */
adminCustomFieldRouter.post(
  '/:webinarId/custom-fields/bulk',
  asyncHandler(async (req, res) => {
    const body = bulkCustomFieldsSchema.parse(req.body);
    const webinarId = req.params.webinarId;

    for (const f of body.fields) {
      assertFieldUsable(f.type, (f.options ?? []).length);
    }

    let order = await nextOrder(webinarId);

    await prisma.$transaction(
      body.fields.map((f) => {
        const thisOrder = f.order ?? order++;
        return prisma.customField.create({
          data: {
            webinarId,
            label: f.label,
            type: f.type,
            isRequired: f.isRequired,
            placeholder: f.placeholder ?? null,
            defaultValueJson:
              f.defaultValue === undefined ? null : JSON.stringify(f.defaultValue),
            order: thisOrder,
            options: {
              create: (f.options ?? []).map((o, i) => ({
                label: o.label,
                value: o.value ?? slugify(o.label),
                order: i,
              })),
            },
          },
        });
      })
    );

    res.status(201).json({ fields: await listFields(webinarId) });
  })
);

/**
 * POST /api/admin/:webinarId/custom-fields/reuse
 *
 * Copies the field set from another webinar. webinar.gg offers this because a
 * host running a weekly series should not retype the same five questions.
 *
 * Options are copied too — sharing option rows would mean editing one webinar's
 * dropdown silently changed another's.
 */
adminCustomFieldRouter.post(
  '/:webinarId/custom-fields/reuse',
  asyncHandler(async (req, res) => {
    const sourceId = String(req.body?.fromWebinarId ?? '');
    if (!sourceId) throw badRequest('fromWebinarId is required');

    const source = await prisma.customField.findMany({
      where: { webinarId: sourceId, deletedAt: null },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
      include: {
        options: {
          where: { deletedAt: null },
          orderBy: { order: 'asc' },
        },
      },
    });

    if (source.length === 0) throw notFound('That webinar has no custom fields');

    const webinarId = req.params.webinarId;
    let order = await nextOrder(webinarId);

    await prisma.$transaction(
      source.map((f) =>
        prisma.customField.create({
          data: {
            webinarId,
            label: f.label,
            type: f.type,
            isRequired: f.isRequired,
            placeholder: f.placeholder,
            defaultValueJson: f.defaultValueJson,
            order: order++,
            options: {
              create: f.options.map((o, i) => ({
                label: o.label,
                value: o.value,
                order: i,
              })),
            },
          },
        })
      )
    );

    res.status(201).json({ fields: await listFields(webinarId) });
  })
);

/**
 * PATCH /api/admin/custom-fields/:id
 *
 * Editing a field keeps its id, so every response already collected stays
 * attached. Changing the `type` of a field that has responses is refused: the
 * stored values would no longer match the new type and the export would be
 * nonsense.
 */
adminCustomFieldRouter.patch(
  '/custom-fields/:id',
  asyncHandler(async (req, res) => {
    const body = updateCustomFieldSchema.parse(req.body);

    const existing = await prisma.customField.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { responses: true } } },
    });
    if (!existing) throw notFound('Field not found');

    if (body.type && body.type !== existing.type && existing._count.responses > 0) {
      throw badRequest(
        'Cannot change the type of a field that already has responses'
      );
    }

    const row = await prisma.customField.update({
      where: { id: req.params.id },
      data: {
        ...(body.label !== undefined ? { label: body.label } : {}),
        ...(body.type !== undefined ? { type: body.type } : {}),
        ...(body.isRequired !== undefined ? { isRequired: body.isRequired } : {}),
        ...(body.placeholder !== undefined ? { placeholder: body.placeholder } : {}),
        ...(body.defaultValue !== undefined
          ? { defaultValueJson: JSON.stringify(body.defaultValue) }
          : {}),
        ...(body.order !== undefined ? { order: body.order } : {}),
      },
      include: { options: { orderBy: { order: 'asc' } } },
    });

    res.json({ field: serializeField(row) });
  })
);

/**
 * DELETE /api/admin/custom-fields/:id
 *
 * Soft delete. The row and its responses survive so a past report still has the
 * column; only the join form stops asking.
 */
adminCustomFieldRouter.delete(
  '/custom-fields/:id',
  asyncHandler(async (req, res) => {
    await prisma.customField.update({
      where: { id: req.params.id },
      data: { deletedAt: new Date() },
    });
    res.json({ ok: true });
  })
);

/**
 * PUT /api/admin/:webinarId/custom-fields/order
 *
 * Reorder. Ids not mentioned keep their relative position after the listed
 * ones, so a partial list is not destructive.
 */
adminCustomFieldRouter.put(
  '/:webinarId/custom-fields/order',
  asyncHandler(async (req, res) => {
    const { order } = reorderCustomFieldsSchema.parse(req.body);
    const webinarId = req.params.webinarId;

    await prisma.$transaction(
      order.map((id, i) =>
        prisma.customField.updateMany({
          where: { id, webinarId },
          data: { order: i },
        })
      )
    );

    res.json({ fields: await listFields(webinarId) });
  })
);

/* ── Options ───────────────────────────────────────────────── */

/** POST /api/admin/custom-fields/:id/options */
adminCustomFieldRouter.post(
  '/custom-fields/:id/options',
  asyncHandler(async (req, res) => {
    const body = customFieldOptionSchema.parse(req.body);

    const last = await prisma.customFieldOption.findFirst({
      where: { fieldId: req.params.id },
      orderBy: { order: 'desc' },
      select: { order: true },
    });

    const option = await prisma.customFieldOption.create({
      data: {
        fieldId: req.params.id,
        label: body.label,
        value: body.value ?? slugify(body.label),
        order: body.order ?? (last?.order ?? -1) + 1,
      },
    });

    res.status(201).json({ option });
  })
);

/** PATCH /api/admin/custom-field-options/:id */
adminCustomFieldRouter.patch(
  '/custom-field-options/:id',
  asyncHandler(async (req, res) => {
    const body = customFieldOptionSchema.partial().parse(req.body);
    const option = await prisma.customFieldOption.update({
      where: { id: req.params.id },
      data: {
        ...(body.label !== undefined ? { label: body.label } : {}),
        ...(body.value !== undefined ? { value: body.value } : {}),
        ...(body.order !== undefined ? { order: body.order } : {}),
      },
    });
    res.json({ option });
  })
);

/**
 * DELETE /api/admin/custom-field-options/:id
 *
 * Soft delete, for the same reason fields are: a response that chose this
 * option must still be able to render its label.
 */
adminCustomFieldRouter.delete(
  '/custom-field-options/:id',
  asyncHandler(async (req, res) => {
    await prisma.customFieldOption.update({
      where: { id: req.params.id },
      data: { deletedAt: new Date() },
    });
    res.json({ ok: true });
  })
);

/** Turn a label into a stable option value: "Yes, please" -> "yes-please". */
function slugify(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'option'
  );
}

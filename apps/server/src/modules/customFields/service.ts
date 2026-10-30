import { prisma } from '../../db/prisma.js';
import type { CustomField, CustomFieldOption, CustomFieldType } from '@webinar/shared';
import { needsOptions, validateFieldValue } from './schema.js';
import { badRequest } from '../../middleware/error.js';

/**
 * Serialise a Prisma field row (with options) into the shared shape.
 *
 * `defaultValueJson` is parsed defensively: a row written by an older build, or
 * by hand, must not crash the join form. A malformed default degrades to
 * `null`, which every consumer already handles.
 */
export function serializeField(row: {
  id: string;
  label: string;
  type: string;
  isRequired: boolean;
  placeholder: string | null;
  defaultValueJson: string | null;
  order: number;
  options: { id: string; label: string; value: string; order: number }[];
}): CustomField {
  let defaultValue: unknown = null;
  if (row.defaultValueJson) {
    try {
      defaultValue = JSON.parse(row.defaultValueJson);
    } catch {
      defaultValue = null;
    }
  }

  return {
    id: row.id,
    label: row.label,
    type: row.type as CustomFieldType,
    isRequired: row.isRequired,
    placeholder: row.placeholder,
    defaultValue,
    order: row.order,
    options: row.options.map(
      (o): CustomFieldOption => ({
        id: o.id,
        label: o.label,
        value: o.value,
        order: o.order,
      })
    ),
  };
}

/** Every live (not soft-deleted) field for a webinar, in display order. */
export async function listFields(webinarId: string): Promise<CustomField[]> {
  const rows = await prisma.customField.findMany({
    where: { webinarId, deletedAt: null },
    orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
    include: {
      options: {
        where: { deletedAt: null },
        orderBy: { order: 'asc' },
      },
    },
  });
  return rows.map(serializeField);
}

/**
 * Validate a submitted answer set against the webinar's live fields.
 *
 * Unknown keys are ignored rather than rejected: a client that still holds a
 * cached form after the host deleted a field should not have its registration
 * fail. Missing required fields are rejected, because that is the whole point
 * of marking a field required.
 */
export async function validateResponses(
  webinarId: string,
  responses: Record<string, unknown>
): Promise<{ fieldId: string; value: unknown }[]> {
  const fields = await listFields(webinarId);
  const out: { fieldId: string; value: unknown }[] = [];

  for (const field of fields) {
    const value = responses[field.id];
    const error = validateFieldValue(field.type, field.isRequired, value);
    if (error) throw badRequest(`${field.label}: ${error}`);
    if (value !== undefined && value !== null && value !== '') {
      out.push({ fieldId: field.id, value });
    }
  }

  return out;
}

/** Persist a validated answer set, replacing anything already stored. */
export async function saveResponses(
  registrationId: string,
  answers: { fieldId: string; value: unknown }[]
): Promise<void> {
  if (answers.length === 0) return;

  await prisma.$transaction([
    prisma.customFieldResponse.deleteMany({ where: { registrationId } }),
    prisma.customFieldResponse.createMany({
      data: answers.map((a) => ({
        registrationId,
        fieldId: a.fieldId,
        valueJson: JSON.stringify(a.value),
      })),
    }),
  ]);
}

/**
 * The next free `order` value for a webinar's fields.
 *
 * Computed from the maximum rather than the count: soft-deleted rows keep their
 * order, so a count would collide with a surviving row.
 */
export async function nextOrder(webinarId: string): Promise<number> {
  const last = await prisma.customField.findFirst({
    where: { webinarId },
    orderBy: { order: 'desc' },
    select: { order: true },
  });
  return (last?.order ?? -1) + 1;
}

/**
 * Reject a field definition that cannot work.
 *
 * A select with no options renders an empty dropdown, which looks like a bug to
 * the attendee and is impossible to answer. Catching it at write time is far
 * cheaper than debugging it at join time.
 */
export function assertFieldUsable(type: string, optionCount: number): void {
  if (needsOptions(type) && optionCount === 0) {
    throw badRequest(`A ${type} field needs at least one option`);
  }
}

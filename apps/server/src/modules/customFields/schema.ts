import { z } from 'zod';
import { CUSTOM_FIELD_TYPES, OPTION_FIELD_TYPES } from '@webinar/shared';

/**
 * A custom field on the registration / join form.
 *
 * `defaultValue` is `unknown` because its type depends on `type`: a checkbox
 * defaults to a boolean, a multi-select to an array, everything else to a
 * string. Validating that pairing is done in `validateFieldValue` rather than
 * in the schema, because zod cannot express "depends on a sibling field"
 * without a discriminated union per type — and a discriminated union would
 * make the bulk-create endpoint unreadable.
 */
export const customFieldSchema = z.object({
  label: z.string().min(1).max(120),
  type: z.enum(CUSTOM_FIELD_TYPES as [string, ...string[]]),
  isRequired: z.boolean().default(false),
  placeholder: z.string().max(160).nullable().optional(),
  defaultValue: z.unknown().optional(),
  order: z.number().int().min(0).optional(),
  options: z
    .array(
      z.object({
        label: z.string().min(1).max(120),
        value: z.string().min(1).max(120).optional(),
      })
    )
    .max(50)
    .optional(),
});

export const updateCustomFieldSchema = customFieldSchema.partial();

/** Bulk create — the "add several fields at once" path webinar.gg offers. */
export const bulkCustomFieldsSchema = z.object({
  fields: z.array(customFieldSchema).min(1).max(50),
});

/** Reorder: an explicit list of ids in their new order. */
export const reorderCustomFieldsSchema = z.object({
  order: z.array(z.string().min(1)).min(1),
});

export const customFieldOptionSchema = z.object({
  label: z.string().min(1).max(120),
  value: z.string().min(1).max(120).optional(),
  order: z.number().int().min(0).optional(),
});

/**
 * The answers submitted with a registration.
 *
 * Keys are field ids. Values are whatever the field type implies — the
 * per-field check happens in `validateResponses`, which has the field rows in
 * hand and can therefore reject a string where a multi-select array belongs.
 */
export const customResponsesSchema = z.record(z.string(), z.unknown());

/**
 * Validate one answer against its field definition.
 *
 * Returns an error string, or null when the value is acceptable. Kept separate
 * from the zod schemas so the same rules apply to a registration, a join token
 * redemption and a bulk import.
 */
export function validateFieldValue(
  type: string,
  isRequired: boolean,
  value: unknown
): string | null {
  const empty =
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0);

  if (empty) return isRequired ? 'This field is required' : null;

  switch (type) {
    case 'number':
      return typeof value === 'number' || !Number.isNaN(Number(value))
        ? null
        : 'Must be a number';
    case 'email':
      return typeof value === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)
        ? null
        : 'Must be a valid email address';
    case 'phone':
      return typeof value === 'string' && /^[+]?[\d\s()-]{6,20}$/.test(value)
        ? null
        : 'Must be a valid phone number';
    case 'date':
      return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? null
        : 'Must be a date (YYYY-MM-DD)';
    case 'time':
      return typeof value === 'string' && /^\d{2}:\d{2}(:\d{2})?$/.test(value)
        ? null
        : 'Must be a time (HH:MM)';
    case 'checkbox':
      return typeof value === 'boolean' ? null : 'Must be true or false';
    case 'multi-select':
      return Array.isArray(value) && value.every((v) => typeof v === 'string')
        ? null
        : 'Must be a list of choices';
    case 'radio':
    case 'select':
      return typeof value === 'string' ? null : 'Must be one of the choices';
    case 'textarea':
    case 'text':
    default:
      return typeof value === 'string' ? null : 'Must be text';
  }
}

/** True when a field type needs an options list to be usable. */
export function needsOptions(type: string): boolean {
  return OPTION_FIELD_TYPES.includes(type as never);
}

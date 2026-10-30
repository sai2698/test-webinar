import { prisma } from '../../db/prisma.js';
import { badRequest } from '../../middleware/error.js';
import type {
  CtaForm,
  CtaFormField,
  CtaFormFieldOption,
  CtaFormFieldType,
  CtaPayload,
} from '@webinar/shared';

/**
 * The offer subsystem's shared plumbing.
 *
 * Three callers need the same two things — the admin router (list/create/edit),
 * the realtime room (show an offer, count a click) and the payments route (turn
 * a click into a purchase). Keeping the serialisation and the click bookkeeping
 * here means the click count can never disagree between the host panel and the
 * participant card.
 */

type CtaRow = {
  id: string;
  title: string;
  description: string | null;
  buttonText: string;
  priceOverridePaise: number | null;
  externalUrl: string | null;
  formEnabled: boolean;
  formIntro: string | null;
  formSubmitText: string;
  course: { pricePaise: number; currency: string } | null;
  formFields: {
    id: string;
    label: string;
    type: string;
    isRequired: boolean;
    placeholder: string | null;
    optionsJson: string;
    order: number;
  }[];
};

/** Parse a stored options blob without letting a bad row break the form. */
function parseOptions(json: string): CtaFormFieldOption[] {
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((o): o is { label: string; value?: string } => Boolean(o) && typeof o.label === 'string')
      .map((o) => ({ label: o.label, value: o.value ?? o.label }));
  } catch {
    return [];
  }
}

/** The form definition, or `null` when the offer has none. */
export function serializeForm(row: CtaRow): CtaForm | null {
  if (!row.formEnabled) return null;

  const fields: CtaFormField[] = row.formFields
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((f) => ({
      id: f.id,
      label: f.label,
      type: f.type as CtaFormFieldType,
      isRequired: f.isRequired,
      placeholder: f.placeholder,
      options: parseOptions(f.optionsJson),
      order: f.order,
    }));

  return {
    intro: row.formIntro,
    submitText: row.formSubmitText,
    fields,
  };
}

/**
 * Build the payload the room broadcasts.
 *
 * `clickCount` is passed in rather than queried here so a caller that already
 * has the tally (the click handler) does not pay for a second round trip.
 */
export function serializeCta(
  row: CtaRow,
  opts: { clickCount: number; clickedByMe: boolean }
): CtaPayload {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    buttonText: row.buttonText,
    priceInPaise: row.priceOverridePaise ?? row.course?.pricePaise ?? 0,
    currency: row.course?.currency ?? 'INR',
    externalUrl: row.externalUrl,
    clickCount: opts.clickCount,
    clickedByMe: opts.clickedByMe,
    form: serializeForm(row),
  };
}

/** The Prisma include every CTA read needs. */
export const CTA_INCLUDE = {
  course: { select: { id: true, title: true, pricePaise: true, currency: true } },
  formFields: {
    select: {
      id: true,
      label: true,
      type: true,
      isRequired: true,
      placeholder: true,
      optionsJson: true,
      order: true,
    },
  },
} as const;

/** How many distinct people have opened this offer. */
export async function countClicks(ctaId: string): Promise<number> {
  return prisma.ctaClick.count({ where: { ctaId } });
}

/**
 * Validate a submitted answer set against the offer's form.
 *
 * Unknown keys are dropped rather than rejected — a client holding a cached
 * form after the host edited it should still be able to buy. Missing required
 * answers are rejected, because that is what "required" means.
 */
export function validateCtaResponses(
  form: CtaForm | null,
  responses: Record<string, unknown>
): Record<string, unknown> {
  if (!form) return {};

  const out: Record<string, unknown> = {};

  for (const field of form.fields) {
    const raw = responses[field.id];
    const empty =
      raw === undefined ||
      raw === null ||
      (typeof raw === 'string' && raw.trim() === '') ||
      (Array.isArray(raw) && raw.length === 0);

    if (empty) {
      if (field.isRequired) throw badRequest(`${field.label} is required`);
      continue;
    }

    if (field.type === 'checkbox') {
      out[field.id] = raw === true || raw === 'true' || raw === 'on';
      continue;
    }

    if (field.type === 'number') {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) throw badRequest(`${field.label} must be a number`);
      out[field.id] = n;
      continue;
    }

    if (field.type === 'email') {
      const s = String(raw).trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) {
        throw badRequest(`${field.label} must be a valid email address`);
      }
      out[field.id] = s;
      continue;
    }

    if (field.type === 'phone') {
      const s = String(raw).trim();
      if (!/^[+]?[\d\s()-]{6,20}$/.test(s)) {
        throw badRequest(`${field.label} must be a valid phone number`);
      }
      out[field.id] = s;
      continue;
    }

    if (field.type === 'select') {
      const s = String(raw).trim();
      const allowed = field.options.map((o) => o.value);
      if (allowed.length > 0 && !allowed.includes(s)) {
        throw badRequest(`${field.label} has an unknown option`);
      }
      out[field.id] = s;
      continue;
    }

    out[field.id] = String(raw).trim().slice(0, 2000);
  }

  return out;
}

/**
 * Record that someone opened an offer.
 *
 * Upserted on `(ctaId, userId)` so a second click refreshes the answers without
 * inflating the count. Returns the new tally so the caller can broadcast it
 * without a follow-up query.
 */
export async function recordClick(
  ctaId: string,
  webinarId: string,
  userId: string,
  responses: Record<string, unknown>
): Promise<number> {
  await prisma.ctaClick.upsert({
    where: { ctaId_userId: { ctaId, userId } },
    create: {
      ctaId,
      webinarId,
      userId,
      responsesJson: JSON.stringify(responses),
    },
    update: {
      // Only overwrite the answers when the caller actually sent some — a bare
      // click must not wipe a form the same person filled in a minute ago.
      ...(Object.keys(responses).length > 0
        ? { responsesJson: JSON.stringify(responses) }
        : {}),
    },
  });

  return countClicks(ctaId);
}

/** Mark the click as converted once the payment is verified. */
export async function markPurchased(ctaId: string, userId: string): Promise<void> {
  await prisma.ctaClick.updateMany({
    where: { ctaId, userId, purchasedAt: null },
    data: { purchasedAt: new Date() },
  });
}

/** Replace an offer's form fields with the supplied list. */
export async function replaceFormFields(
  ctaId: string,
  fields: {
    label: string;
    type?: string;
    isRequired?: boolean;
    placeholder?: string | null;
    options?: { label: string; value?: string }[];
  }[]
): Promise<void> {
  await prisma.$transaction([
    prisma.ctaFormField.deleteMany({ where: { ctaId } }),
    prisma.ctaFormField.createMany({
      data: fields.map((f, i) => ({
        ctaId,
        label: f.label,
        type: f.type ?? 'text',
        isRequired: f.isRequired ?? false,
        placeholder: f.placeholder ?? null,
        // Options only mean something for a select; storing them on a text
        // field would resurrect them if the host switched the type back.
        optionsJson:
          f.type === 'select'
            ? JSON.stringify(
                (f.options ?? []).map((o) => ({ label: o.label, value: o.value ?? o.label }))
              )
            : '[]',
        order: i,
      })),
    }),
  ]);
}

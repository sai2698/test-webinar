import { z } from 'zod';
import { CTA_FORM_FIELD_TYPES } from '@webinar/shared';

export const webinarSettingsSchema = z.object({
  allowMic: z.boolean().default(false),
  allowVideo: z.boolean().default(false),
  requireRegistration: z.boolean().default(true),
  requirePayment: z.boolean().default(false),
  priceInPaise: z.number().int().min(0).default(0),
  currency: z.string().default('INR'),
  chatEnabled: z.boolean().default(true),
  handRaiseEnabled: z.boolean().default(true),
  maxParticipants: z.number().int().positive().nullable().default(null),
  /**
   * Optional room passcode. Empty string clears it — the form sends '' when the
   * host unticks the box, and treating that as "no passcode" is friendlier than
   * making the client send null.
   */
  passcode: z.string().max(64).optional(),
  inviteOnly: z.boolean().default(false),
  requireSignIn: z.boolean().default(false),
  /** Hold every new registration for host approval before it can enter. */
  requireApproval: z.boolean().default(false),
  /**
   * Participant-facing sidebar tabs. All three default to off: a host who has
   * not asked for a roster, a question queue or a poll list should not present
   * an empty one. Staff always see every tab regardless.
   */
  showPeopleTab: z.boolean().default(false),
  showQaTab: z.boolean().default(false),
  showPollsTab: z.boolean().default(false),
  /**
   * Whether participants may see and hear each other. Off by default — a
   * webinar is a broadcast, not a meeting. Staff are always mutually visible.
   */
  showParticipantsToEachOther: z.boolean().default(false),
  /** Stamp the viewer's email across the video, to deter screen recording. */
  watermarkEnabled: z.boolean().default(false),
  /** Show the live headcount to participants, not just to staff. */
  showLiveUsersCount: z.boolean().default(false),
  /** Let a co-host open the room when the host has not arrived. */
  cohostStartWithoutHost: z.boolean().default(false),
  /**
   * Turns the webinar into a premiere: the room plays this recording instead
   * of hosting live media. `null` clears it and returns the webinar to a
   * normal live session.
   */
  premiereRecordingId: z.string().nullable().default(null),
});

export const createWebinarSchema = z.object({
  title: z.string().min(3).max(160),
  description: z.string().max(5000).default(''),
  bannerUrl: z.string().url().or(z.literal('')).optional(),
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/, 'Slug may only contain lowercase letters, numbers and dashes')
    .min(3)
    .max(80)
    .optional(),
  startsAt: z.coerce.date(),
  durationMins: z.number().int().min(5).max(1440).default(60),
  timezone: z.string().default('Asia/Kolkata'),
  hostId: z.string().optional(),
  moderatorIds: z.array(z.string()).default([]),
  status: z.enum(['DRAFT', 'SCHEDULED', 'LIVE', 'ENDED']).default('DRAFT'),
  /**
   * Every field inside has a default, so requiring the object itself is pure
   * friction — an API client creating a webinar with stock settings should not
   * have to send `settings: {}` to satisfy validation.
   */
  settings: webinarSettingsSchema.default({}),
});

export const updateWebinarSchema = createWebinarSchema.partial().extend({
  settings: webinarSettingsSchema.partial().optional(),
  /**
   * When the host opened the session. Normally written by the `webinarStart`
   * socket handler; exposed here so an admin can reset a webinar back to its
   * waiting state (send `null`) or correct a start time.
   */
  startedAt: z.coerce.date().nullable().optional(),
});

/**
 * Phone is required: the join link is a lead-capture surface, and a
 * registration without a reachable number cannot be reminded or followed up.
 * The pattern is deliberately loose — Indian numbers, `+91` prefixes, spaces
 * and dashes all pass — because rejecting a valid number is worse than
 * accepting an odd one.
 */
export const registerSchema = z.object({
  name: z.string().min(2).max(80),
  email: z.string().email(),
  phone: z
    .string()
    .trim()
    .min(6, 'Enter a valid mobile number')
    .max(20, 'Enter a valid mobile number')
    .regex(/^[+]?[\d\s()-]{6,20}$/, 'Enter a valid mobile number'),
  /** Only required when the webinar has one set. */
  passcode: z.string().max(64).optional(),
});

/** The name + mobile prompt shown when a shared join link is opened. */
export const claimSchema = z.object({
  token: z.string().min(8),
  name: z.string().min(2).max(80),
  passcode: z.string().max(64).optional(),
  phone: z
    .string()
    .trim()
    .min(6, 'Enter a valid mobile number')
    .max(20, 'Enter a valid mobile number')
    .regex(/^[+]?[\d\s()-]{6,20}$/, 'Enter a valid mobile number'),
});

export const quizSchema = z.object({
  question: z.string().min(3).max(500),
  options: z
    .array(z.object({ id: z.string(), text: z.string().min(1).max(200) }))
    .min(2)
    .max(6),
  correctOptionId: z.string().optional(),
  timeLimitSecs: z.number().int().min(5).max(300).default(30),
});

/**
 * A poll has no correct answer, so `correctOptionId` is absent and the time
 * limit may be 0 — meaning "leave it open until the host closes it".
 */
export const pollSchema = z.object({
  question: z.string().min(3).max(500),
  options: z
    .array(z.object({ id: z.string(), text: z.string().min(1).max(200) }))
    .min(2)
    .max(6),
  timeLimitSecs: z.number().int().min(0).max(3600).default(0),
});

/**
 * One question on an offer's pre-payment form.
 *
 * `options` is only meaningful for `select`; the handler drops it for every
 * other type rather than rejecting the request, because a host who switches a
 * field from select to text should not have to clear the options by hand.
 */
export const ctaFormFieldSchema = z.object({
  label: z.string().trim().min(1).max(120),
  type: z.enum(CTA_FORM_FIELD_TYPES as [string, ...string[]]).default('text'),
  isRequired: z.boolean().default(false),
  placeholder: z.string().max(160).nullable().optional(),
  options: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(120),
        value: z.string().trim().min(1).max(120).optional(),
      })
    )
    .max(50)
    .optional(),
});

export const ctaSchema = z.object({
  title: z.string().min(2).max(160),
  description: z.string().max(1000).optional(),
  buttonText: z.string().min(1).max(40).default('Enroll Now'),
  courseId: z.string().optional(),
  priceOverridePaise: z.number().int().min(0).optional(),
  externalUrl: z.string().url().optional().or(z.literal('')),
  /** Turns the offer card into a two-step card: form first, then checkout. */
  formEnabled: z.boolean().default(false),
  formIntro: z.string().max(500).nullable().optional(),
  formSubmitText: z.string().min(1).max(40).default('Continue to payment'),
  formFields: z.array(ctaFormFieldSchema).max(20).default([]),
});

/**
 * Editing an offer after it exists.
 *
 * Every field is optional so the host can change one thing — usually the form —
 * without resending the whole offer. `formFields` is the exception: when it is
 * present it *replaces* the field list wholesale, because a partial merge of an
 * ordered list has no sensible meaning.
 */
export const updateCtaSchema = ctaSchema.partial();

/** The answers a participant submits with the form, keyed by field id. */
export const ctaResponsesSchema = z.record(z.string(), z.unknown());

export const courseSchema = z.object({
  title: z.string().min(2).max(160),
  description: z.string().max(2000).optional(),
  pricePaise: z.number().int().min(0),
  currency: z.string().default('INR'),
});

export const orderSchema = z
  .object({
    webinarId: z.string().optional(),
    ctaId: z.string().optional(),
  })
  .refine((v) => Boolean(v.webinarId || v.ctaId), {
    message: 'webinarId or ctaId is required',
  });

export const verifySchema = z.object({
  razorpayOrderId: z.string(),
  razorpayPaymentId: z.string(),
  razorpaySignature: z.string(),
});

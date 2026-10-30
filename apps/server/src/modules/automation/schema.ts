import { z } from 'zod';

/**
 * The automation bundle is a rehearsal script: simulated attendees, the chat
 * and Q&A they post, and timed cues that fire during the session.
 *
 * It is validated strictly — unknown top-level keys are rejected rather than
 * ignored. A bundle with a typo'd key would otherwise import "successfully" and
 * then do nothing, which is the worst possible outcome for a feature whose
 * whole job is to make a rehearsal look real.
 *
 * Every time in the bundle is an offset in milliseconds from the session start,
 * never a wall-clock time. That is what makes a bundle portable: the same file
 * replays identically on any date.
 */

export const AUTOMATION_CUE_KINDS = ['poll', 'offer'] as const;
export type AutomationCueKind = (typeof AUTOMATION_CUE_KINDS)[number];

const personaSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  email: z.string().email(),
  /** Relative likelihood of this persona speaking. 0 disables it. */
  weights: z
    .object({
      chat: z.number().min(0).max(100).default(1),
      qna: z.number().min(0).max(100).default(1),
      poll: z.number().min(0).max(100).default(1),
    })
    .default({ chat: 1, qna: 1, poll: 1 }),
});

const attendancePointSchema = z.object({
  atMs: z.number().int().min(0).max(86_400_000),
  count: z.number().int().min(0).max(100_000),
});

const chatLineSchema = z.object({
  atMs: z.number().int().min(0).max(86_400_000),
  personaId: z.string().min(1).max(64),
  text: z.string().min(1).max(500),
});

const qnaLineSchema = z.object({
  atMs: z.number().int().min(0).max(86_400_000),
  personaId: z.string().min(1).max(64),
  text: z.string().min(1).max(500),
});

const cueSchema = z.object({
  atMs: z.number().int().min(0).max(86_400_000),
  kind: z.enum(AUTOMATION_CUE_KINDS),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export const automationBundleSchema = z
  .object({
    version: z.literal(1),
    personas: z.array(personaSchema).max(100).default([]),
    attendance: z.array(attendancePointSchema).max(500).default([]),
    chat: z.array(chatLineSchema).max(500).default([]),
    qna: z.array(qnaLineSchema).max(500).default([]),
    cues: z.array(cueSchema).max(200).default([]),
  })
  .strict();

export type AutomationBundleInput = z.infer<typeof automationBundleSchema>;

/**
 * Cross-field checks that zod cannot express on a single field.
 *
 * Every chat line and question must reference a persona that exists, or the
 * import produces messages from nobody. Catching that here means the host sees
 * a clear error instead of a silent no-op.
 */
export function validateBundleReferences(bundle: AutomationBundleInput): string[] {
  const problems: string[] = [];
  const ids = new Set(bundle.personas.map((p) => p.id));

  if (ids.size !== bundle.personas.length) {
    problems.push('Persona ids must be unique');
  }

  for (const [i, line] of bundle.chat.entries()) {
    if (!ids.has(line.personaId)) {
      problems.push(`chat[${i}] references unknown persona "${line.personaId}"`);
    }
  }

  for (const [i, q] of bundle.qna.entries()) {
    if (!ids.has(q.personaId)) {
      problems.push(`qna[${i}] references unknown persona "${q.personaId}"`);
    }
  }

  // Attendance must be monotonic in time, or the curve renders backwards.
  for (let i = 1; i < bundle.attendance.length; i++) {
    if (bundle.attendance[i].atMs < bundle.attendance[i - 1].atMs) {
      problems.push(`attendance[${i}] is earlier than attendance[${i - 1}]`);
    }
  }

  return problems;
}

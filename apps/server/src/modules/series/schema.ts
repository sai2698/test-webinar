import { z } from 'zod';
import { SERIES_FREQUENCIES } from '@webinar/shared';
import type { SeriesFrequency } from '@webinar/shared';

export const createSeriesSchema = z.object({
  frequency: z.enum(SERIES_FREQUENCIES as [string, ...string[]]),
  interval: z.number().int().min(1).max(52).default(1),
  /** 0 = Sunday … 6 = Saturday. Only meaningful for WEEKLY. */
  byWeekday: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  /** 1–31. Only meaningful for MONTHLY. */
  byMonthday: z.number().int().min(1).max(31).optional(),
  /** Stop after this many occurrences. Mutually exclusive with `until`. */
  count: z.number().int().min(1).max(200).optional(),
  until: z.coerce.date().optional(),
  timezone: z.string().default('Asia/Kolkata'),
});

export const updateSeriesSchema = createSeriesSchema.partial();

/**
 * Generate the start times for a recurrence rule.
 *
 * Deliberately pure: it takes a rule and a base date and returns dates, with no
 * database access. That makes it testable in isolation and lets the preview
 * endpoint show a host exactly what they are about to create before they
 * create it.
 *
 * `count` and `until` are both honoured if both are given — whichever stops
 * first wins. That is the least surprising reading of "10 occurrences, but not
 * past December".
 */
export function generateOccurrences(
  base: Date,
  rule: {
    frequency: SeriesFrequency;
    interval: number;
    byWeekday: number[];
    byMonthday?: number | null;
    count?: number | null;
    until?: Date | null;
  },
  /** Hard cap, so a bad rule cannot generate thousands of rows. */
  limit = 200
): Date[] {
  const out: Date[] = [];
  const max = Math.min(rule.count ?? limit, limit);

  if (rule.frequency === 'WEEKLY' && rule.byWeekday.length > 0) {
    // Walk day by day from the base date and keep the ones that match. This is
    // simpler and more obviously correct than computing week offsets, and the
    // loop is bounded by `max` occurrences.
    const wanted = new Set(rule.byWeekday);
    const cursor = new Date(base);
    let weekIndex = 0;
    let guard = 0;

    while (out.length < max && guard++ < 366 * 5) {
      const day = cursor.getDay();
      const weekOfSeries = Math.floor(
        (cursor.getTime() - base.getTime()) / (7 * 24 * 3600_000)
      );

      // Only every `interval`-th week counts.
      if (wanted.has(day) && weekOfSeries % rule.interval === 0) {
        if (rule.until && cursor > rule.until) break;
        out.push(new Date(cursor));
      }

      cursor.setDate(cursor.getDate() + 1);
      weekIndex++;
    }

    return out;
  }

  for (let i = 0; i < max; i++) {
    const next = new Date(base);

    switch (rule.frequency) {
      case 'DAILY':
        next.setDate(next.getDate() + i * rule.interval);
        break;
      case 'WEEKLY':
        next.setDate(next.getDate() + i * 7 * rule.interval);
        break;
      case 'MONTHLY': {
        // Set the day-of-month explicitly so a rule anchored on the 31st does
        // not drift to the 28th after February — it clamps per month instead.
        next.setDate(1);
        next.setMonth(next.getMonth() + i * rule.interval);
        const day = rule.byMonthday ?? base.getDate();
        const daysInMonth = new Date(
          next.getFullYear(),
          next.getMonth() + 1,
          0
        ).getDate();
        next.setDate(Math.min(day, daysInMonth));
        break;
      }
      case 'YEARLY':
        next.setFullYear(next.getFullYear() + i * rule.interval);
        break;
    }

    if (rule.until && next > rule.until) break;
    out.push(next);
  }

  return out;
}

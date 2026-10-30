'use client';

import { useCallback, useEffect, useState } from 'react';
import type { QuizOption } from '@webinar/shared';
import { endpoints, ApiError } from '@/lib/api';

interface AdminQuiz {
  id: string;
  question: string;
  options: QuizOption[];
  correctOptionId: string | null;
  timeLimitSecs: number;
  answerCount: number;
}

interface AdminCta {
  id: string;
  title: string;
  description: string | null;
  buttonText: string;
  priceOverridePaise: number | null;
  externalUrl: string | null;
  course: { id: string; title: string; pricePaise: number; currency: string } | null;
}

interface AdminCourse {
  id: string;
  title: string;
  description: string | null;
  pricePaise: number;
  currency: string;
}

type Tab = 'quizzes' | 'offers' | 'courses';

const OPTION_IDS = ['a', 'b', 'c', 'd', 'e', 'f'];

function formatPrice(paise: number) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(paise / 100);
}

/**
 * Authoring surface for the three things a host can push into a live room:
 * quizzes, course offers (CTAs) and the courses those offers point at.
 *
 * Everything here is pre-webinar setup. Launching a quiz or showing an offer
 * happens from the room's Host tools panel, not from this page.
 */
export function EngagementPanel({ webinarId }: { webinarId: string }) {
  const [tab, setTab] = useState<Tab>('quizzes');
  const [quizzes, setQuizzes] = useState<AdminQuiz[]>([]);
  const [ctas, setCtas] = useState<AdminCta[]>([]);
  const [courses, setCourses] = useState<AdminCourse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /* ── quiz draft ─────────────────────────────────────────── */
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [correctIndex, setCorrectIndex] = useState(0);
  const [timeLimit, setTimeLimit] = useState(30);

  /* ── offer draft ────────────────────────────────────────── */
  const [ctaTitle, setCtaTitle] = useState('');
  const [ctaDescription, setCtaDescription] = useState('');
  const [ctaButton, setCtaButton] = useState('Enroll Now');
  const [ctaCourseId, setCtaCourseId] = useState('');
  const [ctaPrice, setCtaPrice] = useState('');

  /* ── course draft ───────────────────────────────────────── */
  const [courseTitle, setCourseTitle] = useState('');
  const [courseDescription, setCourseDescription] = useState('');
  const [coursePrice, setCoursePrice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [q, c, co] = await Promise.all([
        endpoints.quizzes(webinarId) as Promise<{ quizzes: AdminQuiz[] }>,
        endpoints.ctas(webinarId) as Promise<{ ctas: AdminCta[] }>,
        endpoints.courses() as Promise<{ courses: AdminCourse[] }>,
      ]);
      setQuizzes(q.quizzes);
      setCtas(c.ctas);
      setCourses(co.courses);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load engagement assets');
    } finally {
      setLoading(false);
    }
  }, [webinarId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not work');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function addQuiz() {
    const filled = options.map((o) => o.trim()).filter(Boolean);
    if (question.trim().length < 3 || filled.length < 2) {
      setError('A quiz needs a question and at least two answers.');
      return;
    }
    // The correct answer is tracked by index in the form but the API stores
    // option ids, so the index has to survive the filtering above.
    const kept: { id: string; text: string }[] = [];
    let correctId: string | undefined;
    options.forEach((text, i) => {
      if (!text.trim()) return;
      const id = OPTION_IDS[kept.length];
      kept.push({ id, text: text.trim() });
      if (i === correctIndex) correctId = id;
    });

    const ok = await run(() =>
      endpoints.createQuiz(webinarId, {
        question: question.trim(),
        options: kept,
        correctOptionId: correctId,
        timeLimitSecs: timeLimit,
      })
    );
    if (ok) {
      setQuestion('');
      setOptions(['', '']);
      setCorrectIndex(0);
      setTimeLimit(30);
    }
  }

  async function addCta() {
    if (ctaTitle.trim().length < 2) {
      setError('Give the offer a title.');
      return;
    }
    const ok = await run(() =>
      endpoints.createCta(webinarId, {
        title: ctaTitle.trim(),
        description: ctaDescription.trim() || undefined,
        buttonText: ctaButton.trim() || 'Enroll Now',
        courseId: ctaCourseId || undefined,
        priceOverridePaise: ctaPrice ? Math.round(Number(ctaPrice) * 100) : undefined,
      })
    );
    if (ok) {
      setCtaTitle('');
      setCtaDescription('');
      setCtaButton('Enroll Now');
      setCtaCourseId('');
      setCtaPrice('');
    }
  }

  async function addCourse() {
    if (courseTitle.trim().length < 2) {
      setError('Give the course a title.');
      return;
    }
    const ok = await run(() =>
      endpoints.createCourse({
        title: courseTitle.trim(),
        description: courseDescription.trim() || undefined,
        pricePaise: Math.round(Number(coursePrice || 0) * 100),
        currency: 'INR',
      })
    );
    if (ok) {
      setCourseTitle('');
      setCourseDescription('');
      setCoursePrice('');
    }
  }

  return (
    <div className="space-y-4">
      <div className="inline-flex gap-1 rounded-xl border border-line bg-panel-2 p-1">
        {(['quizzes', 'offers', 'courses'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold capitalize transition ${
              tab === t
                ? 'bg-brand-500 text-white shadow-sm'
                : 'text-muted hover:bg-panel hover:text-fg'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-2.5 text-xs text-red-600 dark:text-red-300">
          {error}
        </div>
      )}

      {loading ? (
        <div className="grid place-items-center py-16">
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-line border-t-brand-500" />
        </div>
      ) : tab === 'quizzes' ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-line bg-panel-2 p-5">
            <h3 className="mb-3 text-sm font-semibold text-fg">New quiz</h3>
            <label className="label" htmlFor="quiz-question">
              Question
            </label>
            <input
              id="quiz-question"
              className="input"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Which hook runs after every render?"
            />

            <p className="label mt-3">Answers — pick the correct one</p>
            <div className="space-y-2">
              {options.map((opt, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="correct-option"
                    checked={correctIndex === i}
                    onChange={() => setCorrectIndex(i)}
                    aria-label={`Mark answer ${i + 1} correct`}
                    className="h-3.5 w-3.5 accent-brand-500"
                  />
                  <input
                    className="input flex-1"
                    value={opt}
                    onChange={(e) =>
                      setOptions((prev) => prev.map((o, j) => (j === i ? e.target.value : o)))
                    }
                    placeholder={`Answer ${OPTION_IDS[i].toUpperCase()}`}
                  />
                  {options.length > 2 && (
                    <button
                      onClick={() => setOptions((prev) => prev.filter((_, j) => j !== i))}
                      className="text-xs text-subtle transition hover:text-red-500"
                      aria-label={`Remove answer ${i + 1}`}
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </div>

            {options.length < 6 && (
              <button
                onClick={() => setOptions((prev) => [...prev, ''])}
                className="mt-2 text-xs font-semibold text-brand-500 transition hover:text-brand-600 dark:text-brand-400"
              >
                + Add answer
              </button>
            )}

            <label className="label mt-3" htmlFor="quiz-time">
              Time limit (seconds)
            </label>
            <input
              id="quiz-time"
              type="number"
              min={5}
              max={300}
              className="input"
              value={timeLimit}
              onChange={(e) => setTimeLimit(Number(e.target.value))}
            />

            <button onClick={addQuiz} disabled={busy} className="btn-primary mt-4 w-full py-2 text-sm">
              {busy ? 'Saving…' : 'Add quiz'}
            </button>
          </div>

          <div className="rounded-xl border border-line bg-panel-2 p-5">
            <h3 className="mb-3 text-sm font-semibold text-fg">Quizzes ({quizzes.length})</h3>
            {quizzes.length === 0 ? (
              <p className="py-8 text-center text-xs text-subtle">No quizzes yet.</p>
            ) : (
              <ul className="space-y-2">
                {quizzes.map((q) => (
                  <li key={q.id} className="rounded-xl border border-line bg-panel px-3 py-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-xs font-medium text-fg">{q.question}</p>
                      <button
                        onClick={() => run(() => endpoints.deleteQuiz(q.id))}
                        className="shrink-0 text-[11px] text-subtle transition hover:text-red-500"
                        aria-label={`Delete quiz ${q.question}`}
                      >
                        Delete
                      </button>
                    </div>
                    <p className="mt-1 text-[11px] text-subtle">
                      {q.options.length} answers · {q.timeLimitSecs}s · {q.answerCount} responses
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : tab === 'offers' ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-line bg-panel-2 p-5">
            <h3 className="mb-3 text-sm font-semibold text-fg">New offer</h3>
            <label className="label" htmlFor="cta-title">
              Title
            </label>
            <input
              id="cta-title"
              className="input"
              value={ctaTitle}
              onChange={(e) => setCtaTitle(e.target.value)}
              placeholder="Full-stack bootcamp — 40% off today"
            />

            <label className="label mt-3" htmlFor="cta-description">
              Description
            </label>
            <textarea
              id="cta-description"
              className="input min-h-[70px]"
              value={ctaDescription}
              onChange={(e) => setCtaDescription(e.target.value)}
            />

            <div className="mt-3 grid grid-cols-2 gap-3">
              <div>
                <label className="label" htmlFor="cta-button">
                  Button text
                </label>
                <input
                  id="cta-button"
                  className="input"
                  value={ctaButton}
                  onChange={(e) => setCtaButton(e.target.value)}
                />
              </div>
              <div>
                <label className="label" htmlFor="cta-price">
                  Price override (₹)
                </label>
                <input
                  id="cta-price"
                  type="number"
                  min={0}
                  className="input"
                  value={ctaPrice}
                  onChange={(e) => setCtaPrice(e.target.value)}
                  placeholder="Blank = course price"
                />
              </div>
            </div>

            <label className="label mt-3" htmlFor="cta-course">
              Linked course
            </label>
            <select
              id="cta-course"
              className="input"
              value={ctaCourseId}
              onChange={(e) => setCtaCourseId(e.target.value)}
            >
              <option value="">No course (external link)</option>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title} — {formatPrice(c.pricePaise)}
                </option>
              ))}
            </select>

            <button onClick={addCta} disabled={busy} className="btn-primary mt-4 w-full py-2 text-sm">
              {busy ? 'Saving…' : 'Add offer'}
            </button>
          </div>

          <div className="rounded-xl border border-line bg-panel-2 p-5">
            <h3 className="mb-3 text-sm font-semibold text-fg">Offers ({ctas.length})</h3>
            {ctas.length === 0 ? (
              <p className="py-8 text-center text-xs text-subtle">No offers yet.</p>
            ) : (
              <ul className="space-y-2">
                {ctas.map((c) => (
                  <li key={c.id} className="rounded-xl border border-line bg-panel px-3 py-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-xs font-medium text-fg">{c.title}</p>
                      <button
                        onClick={() => run(() => endpoints.deleteCta(c.id))}
                        className="shrink-0 text-[11px] text-subtle transition hover:text-red-500"
                        aria-label={`Delete offer ${c.title}`}
                      >
                        Delete
                      </button>
                    </div>
                    <p className="mt-1 text-[11px] text-subtle">
                      {c.course ? c.course.title : 'External link'} ·{' '}
                      {c.priceOverridePaise != null
                        ? formatPrice(c.priceOverridePaise)
                        : c.course
                          ? formatPrice(c.course.pricePaise)
                          : 'Free'}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-line bg-panel-2 p-5">
            <h3 className="mb-3 text-sm font-semibold text-fg">New course</h3>
            <label className="label" htmlFor="course-title">
              Title
            </label>
            <input
              id="course-title"
              className="input"
              value={courseTitle}
              onChange={(e) => setCourseTitle(e.target.value)}
            />

            <label className="label mt-3" htmlFor="course-description">
              Description
            </label>
            <textarea
              id="course-description"
              className="input min-h-[70px]"
              value={courseDescription}
              onChange={(e) => setCourseDescription(e.target.value)}
            />

            <label className="label mt-3" htmlFor="course-price">
              Price (₹)
            </label>
            <input
              id="course-price"
              type="number"
              min={0}
              className="input"
              value={coursePrice}
              onChange={(e) => setCoursePrice(e.target.value)}
            />

            <button
              onClick={addCourse}
              disabled={busy}
              className="btn-primary mt-4 w-full py-2 text-sm"
            >
              {busy ? 'Saving…' : 'Add course'}
            </button>
          </div>

          <div className="rounded-xl border border-line bg-panel-2 p-5">
            <h3 className="mb-3 text-sm font-semibold text-fg">Courses ({courses.length})</h3>
            {courses.length === 0 ? (
              <p className="py-8 text-center text-xs text-subtle">No courses yet.</p>
            ) : (
              <ul className="space-y-2">
                {courses.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center justify-between gap-2 rounded-xl border border-line bg-panel px-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium text-fg">{c.title}</p>
                      <p className="text-[11px] text-subtle">{formatPrice(c.pricePaise)}</p>
                    </div>
                    <button
                      onClick={() => run(() => endpoints.deleteCourse(c.id))}
                      className="shrink-0 text-[11px] text-subtle transition hover:text-red-500"
                      aria-label={`Delete course ${c.title}`}
                    >
                      Delete
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

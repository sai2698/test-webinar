/**
 * Verifies the admin engagement surface: quiz authoring, offers, courses,
 * CSV export and the analytics endpoint.
 *
 * Run with the API server up:  node scripts/verify-engagement.mjs
 */
const API = process.env.API_URL ?? 'http://localhost:4000';

let pass = 0;
let fail = 0;

function check(label, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`PASS  ${label}${detail ? `  ${detail}` : ''}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${label}${detail ? `  ${detail}` : ''}`);
  }
}

async function json(path, init = {}) {
  const res = await fetch(`${API}${path}`, init);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { res, body };
}

const login = await json('/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'admin@webinar.local', password: 'Admin@12345' }),
});
check('admin can log in', login.res.ok && Boolean(login.body?.token));

const auth = { Authorization: `Bearer ${login.body.token}` };
const authJson = { ...auth, 'Content-Type': 'application/json' };

const list = await json('/api/admin/webinars', { headers: auth });
const webinar = list.body?.webinars?.find((w) => w.slug === 'live-product-teardown');
check('admin can list webinars', Boolean(webinar), webinar?.slug);
const id = webinar.id;

/* ── courses ──────────────────────────────────────────────── */
const course = await json('/api/admin/courses', {
  method: 'POST',
  headers: authJson,
  body: JSON.stringify({
    title: `Verification Course ${Date.now()}`,
    description: 'Created by verify-engagement.mjs',
    pricePaise: 199900,
    currency: 'INR',
  }),
});
check('admin can create a course', course.res.status === 201, course.body?.course?.title);

const courses = await json('/api/admin/courses', { headers: auth });
check(
  'course appears in the list',
  courses.body?.courses?.some((c) => c.id === course.body?.course?.id)
);

/* ── quizzes ──────────────────────────────────────────────── */
const quiz = await json(`/api/admin/${id}/quizzes`, {
  method: 'POST',
  headers: authJson,
  body: JSON.stringify({
    question: 'Which transport carries media in mediasoup?',
    options: [
      { id: 'a', text: 'WebRtcTransport' },
      { id: 'b', text: 'HttpTransport' },
    ],
    correctOptionId: 'a',
    timeLimitSecs: 20,
  }),
});
check('admin can create a quiz', quiz.res.status === 201, quiz.body?.quiz?.question);

const quizzes = await json(`/api/admin/${id}/quizzes`, { headers: auth });
check(
  'quiz appears in the list',
  quizzes.body?.quizzes?.some((q) => q.id === quiz.body?.quiz?.id)
);

/* ── offers ───────────────────────────────────────────────── */
const cta = await json(`/api/admin/${id}/ctas`, {
  method: 'POST',
  headers: authJson,
  body: JSON.stringify({
    title: 'Verification offer',
    description: 'Created by verify-engagement.mjs',
    buttonText: 'Enroll',
    courseId: course.body?.course?.id,
  }),
});
check('admin can create an offer', cta.res.status === 201, cta.body?.cta?.title);
check(
  'offer resolves its course',
  cta.body?.cta?.course?.id === course.body?.course?.id,
  cta.body?.cta?.course?.title
);

/* ── analytics + CSV ──────────────────────────────────────── */
const analytics = await json(`/api/admin/webinars/${id}/analytics`, { headers: auth });
check('analytics endpoint responds', analytics.res.ok);
check(
  'analytics reports registrations',
  typeof analytics.body?.analytics?.registrations === 'number',
  String(analytics.body?.analytics?.registrations)
);
check(
  'analytics reports revenue',
  typeof analytics.body?.analytics?.revenuePaise === 'number',
  String(analytics.body?.analytics?.revenuePaise)
);
check(
  'analytics includes quiz stats',
  Array.isArray(analytics.body?.analytics?.quizzes)
);

const csvRes = await fetch(`${API}/api/admin/webinars/${id}/registrations?format=csv`, {
  headers: auth,
});
const csv = await csvRes.text();
check('CSV export responds', csvRes.ok);
check(
  'CSV is served as a download',
  (csvRes.headers.get('content-type') ?? '').includes('text/csv'),
  csvRes.headers.get('content-type') ?? ''
);
check('CSV has a header row', csv.split('\n')[0].toLowerCase().includes('email'));

/* ── cleanup ──────────────────────────────────────────────── */
const delQuiz = await json(`/api/admin/quizzes/${quiz.body.quiz.id}`, {
  method: 'DELETE',
  headers: auth,
});
check('admin can delete a quiz', delQuiz.res.ok);

const delCta = await json(`/api/admin/ctas/${cta.body.cta.id}`, {
  method: 'DELETE',
  headers: auth,
});
check('admin can delete an offer', delCta.res.ok);

const delCourse = await json(`/api/admin/courses/${course.body.course.id}`, {
  method: 'DELETE',
  headers: auth,
});
check('admin can delete a course', delCourse.res.ok);

console.log(`\n${pass}/${pass + fail} checks passed`);
console.log(`RESULT: ${fail === 0 ? 'PASS' : 'FAIL'}`);
// process.exit() trips a libuv assertion on Windows and reports the wrong
// code, so the exit status is set and the process is allowed to drain.
process.exitCode = fail === 0 ? 0 : 1;

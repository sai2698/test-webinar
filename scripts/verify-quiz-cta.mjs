// Verifies the quiz and CTA realtime flows end to end.
//   host  : launches quiz -> participant answers -> host closes -> results broadcast
//   host  : shows CTA -> participant receives payload -> host hides -> ctaHidden
import { io } from 'socket.io-client';

const API = 'http://localhost:4000';
const SLUG = 'live-product-teardown';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function register(name, email) {
  const res = await fetch(`${API}/api/webinars/${SLUG}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Phone is required since the join link became a lead-capture surface.
    body: JSON.stringify({ name, email, phone: '+91 98765 43210' }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function login(email, password) {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const socket = io(API, { auth: { token }, transports: ['websocket'] });
    socket.on('connect_error', reject);
    socket.on('connect', () => resolve(socket));
  });
}

const emit = (socket, event, payload) =>
  new Promise((resolve) => socket.emit(event, payload, resolve));

const checks = [];
function check(label, ok, detail) {
  checks.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
}

const run = async () => {
  const stamp = Date.now();
  const host = await login('admin@webinar.local', 'Admin@12345');
  const viewerEmail = `quizviewer${stamp}@example.com`;
  const viewer = await register('Quiz Viewer', viewerEmail);

  // Discover the webinar id + its quizzes/CTAs through the admin API.
  const auth = { Authorization: `Bearer ${host.token}` };
  const listRes = await fetch(`${API}/api/admin/webinars`, { headers: auth });
  if (!listRes.ok) throw new Error(`webinar list: ${listRes.status} ${await listRes.text()}`);
  const webinar = (await listRes.json()).webinars.find((w) => w.slug === SLUG);
  if (!webinar) throw new Error(`Webinar ${SLUG} not found`);

  const quizzes = (await (await fetch(`${API}/api/admin/${webinar.id}/quizzes`, { headers: auth })).json())
    .quizzes;
  const ctas = (await (await fetch(`${API}/api/admin/${webinar.id}/ctas`, { headers: auth })).json()).ctas;

  if (!quizzes.length) throw new Error('No quizzes seeded for this webinar');
  if (!ctas.length) throw new Error('No CTAs seeded for this webinar');

  const quiz = quizzes[0];
  const cta = ctas[0];
  console.log(`webinar : ${webinar.id}`);
  console.log(`quiz    : ${quiz.id} — ${quiz.question}`);
  console.log(`cta     : ${cta.id} — ${cta.title}\n`);

  const hostSocket = await connect(host.token);
  const viewerSocket = await connect(viewer.token);

  const hostJoin = await emit(hostSocket, 'join', { slug: SLUG, token: host.token });
  const viewerJoin = await emit(viewerSocket, 'join', { slug: SLUG, token: viewer.token });
  if (!hostJoin.ok) throw new Error(`host join: ${hostJoin.error}`);
  if (!viewerJoin.ok) throw new Error(`viewer join: ${viewerJoin.error}`);
  console.log(`host role   : ${hostJoin.data.role}`);
  console.log(`viewer role : ${viewerJoin.data.role}\n`);

  /* ── quiz ─────────────────────────────────────────────── */
  const seen = { quizStarted: null, quizResults: null, quizClosed: null, ctaShown: null, ctaHidden: 0 };
  viewerSocket.on('quizStarted', (q) => (seen.quizStarted = q));
  viewerSocket.on('quizResults', (r) => (seen.quizResults = r));
  viewerSocket.on('quizClosed', (p) => (seen.quizClosed = p));
  viewerSocket.on('ctaShown', (p) => (seen.ctaShown = p));
  viewerSocket.on('ctaHidden', () => (seen.ctaHidden += 1));

  const launched = await emit(hostSocket, 'quizLaunch', { quizId: quiz.id });
  check('host can launch quiz', launched.ok === true, launched.error ?? '');
  await sleep(600);
  check(
    'participant receives quizStarted',
    seen.quizStarted?.id === quiz.id,
    seen.quizStarted ? `"${seen.quizStarted.question}"` : 'no event'
  );
  check(
    'quizStarted hides the correct answer',
    seen.quizStarted != null && !('correctOptionId' in seen.quizStarted),
    seen.quizStarted ? `keys=${Object.keys(seen.quizStarted).join(',')}` : ''
  );

  // Participant answers with the correct option.
  const correctOptionId = quiz.correctOptionId ?? quiz.options[0].id;
  const answered = await emit(viewerSocket, 'quizAnswer', { quizId: quiz.id, optionId: correctOptionId });
  check('participant can answer', answered.ok === true, answered.error ?? '');
  check('answer graded correctly', answered.ok && answered.data?.correct === true, JSON.stringify(answered.data));

  const dupe = await emit(viewerSocket, 'quizAnswer', { quizId: quiz.id, optionId: correctOptionId });
  check('duplicate answer rejected', dupe.ok === false, dupe.error ?? '');

  const closed = await emit(hostSocket, 'quizClose', { quizId: quiz.id });
  check('host can close quiz', closed.ok === true, closed.error ?? '');
  await sleep(600);
  check(
    'participant receives quizResults',
    seen.quizResults?.quizId === quiz.id,
    seen.quizResults ? `total=${seen.quizResults.totalAnswers} correct=${seen.quizResults.correctCount}` : 'no event'
  );
  check(
    'results expose the correct option',
    seen.quizResults?.correctOptionId === correctOptionId,
    seen.quizResults?.correctOptionId ?? ''
  );
  check('participant receives quizClosed', seen.quizClosed?.quizId === quiz.id, JSON.stringify(seen.quizClosed));

  /* ── CTA ──────────────────────────────────────────────── */
  const shown = await emit(hostSocket, 'ctaShow', { ctaId: cta.id });
  check('host can show CTA', shown.ok === true, shown.error ?? '');
  await sleep(600);
  check(
    'participant receives ctaShown',
    seen.ctaShown?.id === cta.id,
    seen.ctaShown ? `"${seen.ctaShown.title}" ${seen.ctaShown.priceInPaise}p` : 'no event'
  );
  check(
    'CTA carries a price',
    typeof seen.ctaShown?.priceInPaise === 'number' && seen.ctaShown.priceInPaise > 0,
    String(seen.ctaShown?.priceInPaise)
  );

  const hidden = await new Promise((resolve) => hostSocket.emit('ctaHide', resolve));
  check('host can hide CTA', hidden.ok === true, hidden.error ?? '');
  await sleep(600);
  check('participant receives ctaHidden', seen.ctaHidden === 1, `count=${seen.ctaHidden}`);

  /* ── permissions ──────────────────────────────────────── */
  const denied = await emit(viewerSocket, 'quizLaunch', { quizId: quiz.id });
  check('participant cannot launch a quiz', denied.ok === false, denied.error ?? '');
  const deniedCta = await emit(viewerSocket, 'ctaShow', { ctaId: cta.id });
  check('participant cannot show a CTA', deniedCta.ok === false, deniedCta.error ?? '');

  /* ── CTA click tracking + pre-payment form ─────────────
   * A fresh offer per run, so the tally starts at zero and the assertions do
   * not depend on whatever the demo webinar happens to carry.
   */
  const created = await fetch(`${API}/api/admin/${webinar.id}/ctas`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: `Form Offer ${stamp}`,
      description: 'Offer with a pre-payment form',
      buttonText: 'Get access',
      priceOverridePaise: 210000,
      formEnabled: true,
      formIntro: 'We need a few details to send your access.',
      formSubmitText: 'Pay now',
      formFields: [
        { label: 'Full name', type: 'text', isRequired: true },
        { label: 'Work email', type: 'email', isRequired: true },
        { label: 'Company size', type: 'select', options: [{ label: '1-10' }, { label: '11-50' }] },
      ],
    }),
  });
  const createdBody = await created.json();
  const formCta = createdBody.cta;
  check('offer with a form can be created', created.status === 201 && !!formCta?.id, `status=${created.status}`);
  check(
    'created offer returns its form',
    formCta?.form?.fields?.length === 3,
    `fields=${formCta?.form?.fields?.length}`
  );
  check(
    'form field types survive the round trip',
    formCta?.form?.fields?.[1]?.type === 'email' && formCta?.form?.fields?.[2]?.type === 'select',
    formCta?.form?.fields?.map((f) => f.type).join(',')
  );
  check(
    'select options are stored',
    formCta?.form?.fields?.[2]?.options?.length === 2,
    JSON.stringify(formCta?.form?.fields?.[2]?.options)
  );
  check('new offer starts at zero clicks', formCta?.clickCount === 0, String(formCta?.clickCount));

  // Show it so the participant has something to click.
  const shownForm = await emit(hostSocket, 'ctaShow', { ctaId: formCta.id });
  check('host can show the form offer', shownForm.ok === true, shownForm.error ?? '');
  await sleep(400);
  check(
    'participant receives the form with the offer',
    seen.ctaShown?.id === formCta.id && seen.ctaShown?.form?.fields?.length === 3,
    `fields=${seen.ctaShown?.form?.fields?.length}`
  );

  // Staff-only tally broadcast.
  let staffTally = null;
  let viewerTally = null;
  hostSocket.on('ctaClicks', (p) => (staffTally = p));
  viewerSocket.on('ctaClicks', (p) => (viewerTally = p));

  const click1 = await emit(viewerSocket, 'ctaClick', { ctaId: formCta.id });
  check('participant can click an offer', click1.ok === true, click1.error ?? '');
  check('first click counts as one', click1.data?.clickCount === 1, String(click1.data?.clickCount));
  await sleep(400);
  check(
    'staff receive the click tally',
    staffTally?.ctaId === formCta.id && staffTally?.clickCount === 1,
    JSON.stringify(staffTally)
  );
  check('participants never receive the tally', viewerTally === null, JSON.stringify(viewerTally));

  const click2 = await emit(viewerSocket, 'ctaClick', { ctaId: formCta.id });
  check(
    'a repeat click does not inflate the count',
    click2.ok === true && click2.data?.clickCount === 1,
    String(click2.data?.clickCount)
  );

  // A required field left blank must be rejected.
  const blank = await emit(viewerSocket, 'ctaClick', {
    ctaId: formCta.id,
    responses: { [formCta.form.fields[0].id]: '' },
  });
  check('a blank required field is rejected', blank.ok === false, blank.error ?? '');

  // A valid submission persists the answers.
  const answers = {
    [formCta.form.fields[0].id]: 'Asha Menon',
    [formCta.form.fields[1].id]: 'asha@example.com',
    [formCta.form.fields[2].id]: '11-50',
  };
  const submitted = await emit(viewerSocket, 'ctaClick', { ctaId: formCta.id, responses: answers });
  check('a filled form is accepted', submitted.ok === true, submitted.error ?? '');
  check(
    'submitting the form does not double-count',
    submitted.data?.clickCount === 1,
    String(submitted.data?.clickCount)
  );

  const clicksRes = await fetch(`${API}/api/admin/ctas/${formCta.id}/clicks`, { headers: auth });
  const clicksBody = await clicksRes.json();
  check('host can read the click list', clicksRes.status === 200 && clicksBody.total === 1, `total=${clicksBody.total}`);
  check(
    'the click list names the clicker',
    clicksBody.clicks?.[0]?.email === viewer.user.email,
    clicksBody.clicks?.[0]?.email ?? 'none'
  );
  check(
    'the click list carries the form answers',
    clicksBody.clicks?.[0]?.responses?.[formCta.form.fields[0].id] === 'Asha Menon',
    JSON.stringify(clicksBody.clicks?.[0]?.responses)
  );
  check('nothing is marked purchased yet', clicksBody.purchased === 0, String(clicksBody.purchased));

  /* ── Follow-up list ─────────────────────────────────────
   * The count says the offer is landing; the list says who to call. It has to
   * carry contact details, the answers, and where each person got to in
   * checkout — and it has to be readable by a co-host, whose JWT role is still
   * PARTICIPANT.
   *
   * Read before the form is edited, because editing replaces the field list
   * wholesale and the answers on file then refer to fields that no longer
   * exist. That case is asserted separately below.
   */
  const followUp = await fetch(`${API}/api/admin/ctas/${formCta.id}/follow-up`, {
    headers: auth,
  });
  const followBody = await followUp.json();
  check('host can read the follow-up list', followUp.status === 200, `status=${followUp.status}`);
  check(
    'the follow-up list names the person',
    followBody.people?.[0]?.email === viewerEmail,
    followBody.people?.[0]?.email
  );
  check(
    'the follow-up list carries their phone',
    Boolean(followBody.people?.[0]?.phone),
    String(followBody.people?.[0]?.phone)
  );
  check(
    'the follow-up list says the form was filled',
    followBody.people?.[0]?.formFilled === true,
    String(followBody.people?.[0]?.formFilled)
  );
  check(
    'the follow-up list carries the answers',
    Object.values(followBody.people?.[0]?.responses ?? {}).includes('Asha Menon'),
    JSON.stringify(followBody.people?.[0]?.responses)
  );
  check(
    'the follow-up list reports the payment status',
    followBody.people?.[0]?.paymentStatus === null ||
      typeof followBody.people?.[0]?.paymentStatus === 'string',
    String(followBody.people?.[0]?.paymentStatus)
  );
  check(
    'the follow-up list summarises the funnel',
    followBody.summary?.clicked === 1 && followBody.summary?.formFilled === 1,
    JSON.stringify(followBody.summary)
  );
  check(
    'the follow-up list exposes the form labels',
    Array.isArray(followBody.fields) && followBody.fields.length === 3,
    `fields=${followBody.fields?.length}`
  );

  // A participant must not be able to read the room's commercial activity.
  const deniedFollowUp = await fetch(`${API}/api/admin/ctas/${formCta.id}/follow-up`, {
    headers: { Authorization: `Bearer ${viewer.token}` },
  });
  check(
    'a participant cannot read the follow-up list',
    deniedFollowUp.status === 403,
    `status=${deniedFollowUp.status}`
  );

  // Editing the form replaces the field list wholesale.
  const patched = await fetch(`${API}/api/admin/ctas/${formCta.id}`, {
    method: 'PATCH',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      formEnabled: true,
      formSubmitText: 'Continue',
      formFields: [{ label: 'Phone', type: 'phone', isRequired: true }],
    }),
  });
  const patchedBody = await patched.json();
  check('host can edit an offer form', patched.status === 200, `status=${patched.status}`);
  check(
    'editing replaces the field list',
    patchedBody.cta?.form?.fields?.length === 1 &&
      patchedBody.cta?.form?.fields?.[0]?.type === 'phone',
    `fields=${patchedBody.cta?.form?.fields?.length}`
  );
  check(
    'editing keeps the click count',
    patchedBody.cta?.clickCount === 1,
    String(patchedBody.cta?.clickCount)
  );

  // Turning the form off returns the offer to a one-click checkout.
  const off = await fetch(`${API}/api/admin/ctas/${formCta.id}`, {
    method: 'PATCH',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ formEnabled: false }),
  });
  const offBody = await off.json();
  check('a form can be turned off', offBody.cta?.form === null, JSON.stringify(offBody.cta?.form));

  // The answers on file now refer to fields the host has deleted. They must
  // still be readable — the host is chasing a lead, not auditing a schema — but
  // they must not count as a completed form, or the funnel would overstate
  // itself every time a host tidied up their questions.
  const stale = await fetch(`${API}/api/admin/ctas/${formCta.id}/follow-up`, { headers: auth });
  const staleBody = await stale.json();
  check(
    'answers to deleted fields are still readable',
    Object.values(staleBody.people?.[0]?.responses ?? {}).includes('Asha Menon'),
    JSON.stringify(staleBody.people?.[0]?.responses)
  );
  check(
    'answers to deleted fields do not count as a filled form',
    staleBody.people?.[0]?.formFilled === false,
    String(staleBody.people?.[0]?.formFilled)
  );
  check(
    'the funnel follows the current form',
    staleBody.summary?.formFilled === 0,
    JSON.stringify(staleBody.summary)
  );

  // Clean up the fixture offer.
  await fetch(`${API}/api/admin/ctas/${formCta.id}`, { method: 'DELETE', headers: auth });

  /* ── editing and deleting authored assets ───────────────
   * The host can now fix a typo without deleting and re-creating, and can
   * remove an asset outright. The interesting case is the option list: once
   * people have answered, the stored rows reference option ids that live only
   * inside `optionsJson`, so rewriting the list would orphan every answer.
   * The question and the time limit stay editable — those are safe.
   */
  const editQuizRes = await fetch(`${API}/api/admin/${webinar.id}/quizzes`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question: `Editable quiz ${stamp}?`,
      options: [
        { id: 'a', text: 'First' },
        { id: 'b', text: 'Second' },
      ],
      correctOptionId: 'a',
      timeLimitSecs: 20,
    }),
  });
  const editQuiz = (await editQuizRes.json()).quiz;
  check('a quiz can be created for editing', editQuizRes.status === 201, `status=${editQuizRes.status}`);

  const patchQuizRes = await fetch(`${API}/api/admin/quizzes/${editQuiz.id}`, {
    method: 'PATCH',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question: `Edited quiz ${stamp}?`,
      options: [
        { id: 'a', text: 'First' },
        { id: 'b', text: 'Second' },
      ],
      correctOptionId: 'b',
      timeLimitSecs: 45,
    }),
  });
  const patchedQuiz = (await patchQuizRes.json()).quiz;
  check('a quiz can be edited', patchQuizRes.status === 200, `status=${patchQuizRes.status}`);
  check('the edited question is saved', patchedQuiz?.question === `Edited quiz ${stamp}?`, patchedQuiz?.question);
  check('the edited time limit is saved', patchedQuiz?.timeLimitSecs === 45, String(patchedQuiz?.timeLimitSecs));
  check('the edited correct answer is saved', patchedQuiz?.correctOptionId === 'b', String(patchedQuiz?.correctOptionId));

  // Answer it, then try to rewrite the options.
  const editLaunch = await emit(hostSocket, 'quizLaunch', { quizId: editQuiz.id });
  check('the edited quiz can be launched', editLaunch.ok === true, editLaunch.error ?? '');
  await sleep(400);
  await emit(viewerSocket, 'quizAnswer', { quizId: editQuiz.id, optionId: 'b' });
  await sleep(300);

  const lockedQuizRes = await fetch(`${API}/api/admin/quizzes/${editQuiz.id}`, {
    method: 'PATCH',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question: `Edited quiz ${stamp}?`,
      options: [
        { id: 'a', text: 'Renamed' },
        { id: 'b', text: 'Second' },
      ],
      correctOptionId: 'b',
      timeLimitSecs: 45,
    }),
  });
  const lockedQuizBody = await lockedQuizRes.json();
  check('quiz options are locked once answered', lockedQuizRes.status === 400, `status=${lockedQuizRes.status}`);
  check(
    'the lock explains itself',
    typeof lockedQuizBody.error === 'string' && lockedQuizBody.error.includes('already has answers'),
    lockedQuizBody.error
  );

  // The question alone must still be editable — that is the whole point.
  const questionOnlyRes = await fetch(`${API}/api/admin/quizzes/${editQuiz.id}`, {
    method: 'PATCH',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question: `Edited quiz ${stamp}?`,
      options: [
        { id: 'a', text: 'First' },
        { id: 'b', text: 'Second' },
      ],
      correctOptionId: 'b',
      timeLimitSecs: 60,
    }),
  });
  check('the time limit stays editable after answers', questionOnlyRes.status === 200, `status=${questionOnlyRes.status}`);

  const delQuizRes = await fetch(`${API}/api/admin/quizzes/${editQuiz.id}`, {
    method: 'DELETE',
    headers: auth,
  });
  check('a quiz can be deleted', delQuizRes.status === 200, `status=${delQuizRes.status}`);

  // ── polls ──
  const editPollRes = await fetch(`${API}/api/admin/${webinar.id}/polls`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question: `Editable poll ${stamp}?`,
      options: [
        { id: 'a', text: 'Yes' },
        { id: 'b', text: 'No' },
      ],
      timeLimitSecs: 0,
    }),
  });
  const editPoll = (await editPollRes.json()).poll;
  check('a poll can be created for editing', editPollRes.status === 201, `status=${editPollRes.status}`);

  const patchPollRes = await fetch(`${API}/api/admin/polls/${editPoll.id}`, {
    method: 'PATCH',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question: `Edited poll ${stamp}?`,
      options: [
        { id: 'a', text: 'Yes' },
        { id: 'b', text: 'No' },
      ],
      timeLimitSecs: 90,
    }),
  });
  const patchedPoll = (await patchPollRes.json()).poll;
  check('a poll can be edited', patchPollRes.status === 200, `status=${patchPollRes.status}`);
  check('the edited poll question is saved', patchedPoll?.question === `Edited poll ${stamp}?`, patchedPoll?.question);
  check('the edited poll time limit is saved', patchedPoll?.timeLimitSecs === 90, String(patchedPoll?.timeLimitSecs));

  const editPollLaunch = await emit(hostSocket, 'pollLaunch', { pollId: editPoll.id });
  check('the edited poll can be launched', editPollLaunch.ok === true, editPollLaunch.error ?? '');
  await sleep(400);
  await emit(viewerSocket, 'pollVote', { pollId: editPoll.id, optionId: 'a' });
  await sleep(300);

  const lockedPollRes = await fetch(`${API}/api/admin/polls/${editPoll.id}`, {
    method: 'PATCH',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question: `Edited poll ${stamp}?`,
      options: [
        { id: 'a', text: 'Renamed' },
        { id: 'b', text: 'No' },
      ],
      timeLimitSecs: 90,
    }),
  });
  const lockedPollBody = await lockedPollRes.json();
  check('poll options are locked once voted on', lockedPollRes.status === 400, `status=${lockedPollRes.status}`);
  check(
    'the poll lock explains itself',
    typeof lockedPollBody.error === 'string' && lockedPollBody.error.includes('already has votes'),
    lockedPollBody.error
  );

  const delPollRes = await fetch(`${API}/api/admin/polls/${editPoll.id}`, {
    method: 'DELETE',
    headers: auth,
  });
  check('a poll can be deleted', delPollRes.status === 200, `status=${delPollRes.status}`);

  // ── offers ──
  const editOfferRes = await fetch(`${API}/api/admin/${webinar.id}/ctas`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: `Editable offer ${stamp}`,
      buttonText: 'Enroll Now',
      priceOverridePaise: 100000,
      formEnabled: false,
      formFields: [],
    }),
  });
  const editOffer = (await editOfferRes.json()).cta;
  check('an offer can be created for editing', editOfferRes.status === 201, `status=${editOfferRes.status}`);

  const patchOfferRes = await fetch(`${API}/api/admin/ctas/${editOffer.id}`, {
    method: 'PATCH',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: `Edited offer ${stamp}`,
      buttonText: 'Buy now',
      priceOverridePaise: 250000,
    }),
  });
  const patchedOffer = (await patchOfferRes.json()).cta;
  check('an offer can be edited', patchOfferRes.status === 200, `status=${patchOfferRes.status}`);
  check('the edited offer title is saved', patchedOffer?.title === `Edited offer ${stamp}`, patchedOffer?.title);
  check('the edited offer price is saved', patchedOffer?.priceOverridePaise === 250000, String(patchedOffer?.priceOverridePaise));
  check('the edited offer button is saved', patchedOffer?.buttonText === 'Buy now', patchedOffer?.buttonText);

  const delOfferRes = await fetch(`${API}/api/admin/ctas/${editOffer.id}`, {
    method: 'DELETE',
    headers: auth,
  });
  check('an offer can be deleted', delOfferRes.status === 200, `status=${delOfferRes.status}`);

  hostSocket.disconnect();
  viewerSocket.disconnect();

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  console.log(`RESULT: ${failed.length === 0 ? 'PASS' : 'FAIL'}`);
  // process.exit() trips a libuv assertion on Windows and reports the wrong
  // code, so the exit status is set and the process is allowed to drain.
  process.exitCode = failed.length === 0 ? 0 : 1;
};

run().catch((err) => {
  console.error('ERROR:', err.message);
  process.exitCode = 1;
});

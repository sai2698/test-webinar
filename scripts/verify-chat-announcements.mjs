/**
 * Verifies that a purchase is announced in the room's chat.
 *
 * The interesting case is the buyer who is *not* connected. The original
 * bridge only announced when `room.getPeerByUserId()` found a live peer, so a
 * checkout completed on a phone after the tab was closed produced silence —
 * exactly the sale the room most wants to celebrate. This suite buys from a
 * participant who never joins the socket and asserts the announcement still
 * lands, carries the buyer's real name, and is tagged so the client can style
 * it differently from housekeeping lines.
 *
 * Run with the API server up:  node scripts/verify-chat-announcements.mjs
 */
import {
  api,
  connect,
  createChecker,
  dropWebinar,
  emit,
  login,
  makeWebinar,
  register,
  runSuite,
  sleep,
  waitFor,
} from './lib/parity-harness.mjs';

runSuite('chat enrollment announcements', async () => {
  const { check, finish } = createChecker();
  const { token } = await login();

  const webinar = await makeWebinar(token, { title: `Announce Fixture ${Date.now()}` });
  const id = webinar.id;
  const slug = webinar.slug;

  let hostSocket = null;
  let courseId = null;

  try {
    // A course is what makes a purchase an *enrollment* rather than a seat
    // payment — the announcement is emitted from the enrollment branch.
    const course = await api('/api/admin/courses', {
      method: 'POST',
      token,
      body: {
        title: `Announce Course ${Date.now()}`,
        description: 'Created by verify-chat-announcements.mjs',
        pricePaise: 49900,
        currency: 'INR',
      },
    });
    check('admin can create a course', course.status === 201, String(course.status));
    courseId = course.json?.course?.id ?? null;

    const cta = await api(`/api/admin/${id}/ctas`, {
      method: 'POST',
      token,
      body: {
        title: 'Announce Offer',
        buttonText: 'Enroll',
        courseId,
        priceOverridePaise: 49900,
      },
    });
    check('admin can create an offer', cta.status === 201, String(cta.status));
    const ctaId = cta.json?.cta?.id ?? cta.json?.id ?? null;

    // The host must be in the room for the announcement to have an audience.
    hostSocket = await connect(token);
    const join = await emit(hostSocket, 'join', { slug, token });
    check('host joins the room', join?.ok === true, join?.error ?? '');

    // A buyer who registers but never opens a socket. This is the case the
    // original implementation silently dropped.
    const buyer = await register(slug, 'Absent Buyer', `absent-${Date.now()}@example.com`);
    check('buyer registers', Boolean(buyer?.token));

    const order = await api('/api/payments/order', {
      method: 'POST',
      token: buyer.token,
      body: { ctaId },
    });
    check('buyer can create an order', order.status === 200, String(order.status));

    const orderId = order.json?.orderId;
    const announcement = waitFor(hostSocket, 'chatMessage', 6000);

    const verify = await api('/api/payments/verify', {
      method: 'POST',
      token: buyer.token,
      body: {
        razorpayOrderId: orderId,
        razorpayPaymentId: `pay_test_${Date.now()}`,
        // The mock verifier accepts `mock_<orderId>` when Razorpay is unset.
        razorpaySignature: `mock_${orderId}`,
      },
    });
    check('payment verifies', verify.status === 200, verify.text.slice(0, 120));

    const msg = await announcement;
    check('an announcement reaches the room', Boolean(msg), msg ? '' : 'timed out');
    check('the announcement is a system line', msg?.system === true, String(msg?.system));
    check(
      'the announcement is tagged as an enrollment',
      msg?.kind === 'enrollment',
      String(msg?.kind)
    );
    check(
      'the announcement names the absent buyer',
      typeof msg?.text === 'string' && msg.text.includes('Absent Buyer'),
      msg?.text ?? ''
    );
    check(
      'the announcement names the course',
      typeof msg?.text === 'string' && msg.text.includes('Announce Course'),
      msg?.text ?? ''
    );
    // The two nouns are what let the chat card and the stage toast phrase the
    // same fact differently. Without them the client has to parse the sentence.
    check(
      'the announcement carries the buyer as `actor`',
      msg?.actor === 'Absent Buyer',
      String(msg?.actor)
    );
    check(
      'the announcement carries the course as `subject`',
      typeof msg?.subject === 'string' && msg.subject.includes('Announce Course'),
      String(msg?.subject)
    );

    // Housekeeping lines must stay untagged so the client keeps rendering them
    // as the plain grey pill.
    const info = waitFor(hostSocket, 'chatMessage', 4000);
    const recStart = await emit(hostSocket, 'recordingStart', {});
    if (recStart?.ok) {
      const infoMsg = await info;
      check(
        'a housekeeping line is not tagged as an enrollment',
        infoMsg?.kind !== 'enrollment',
        String(infoMsg?.kind)
      );
      await emit(hostSocket, 'recordingStop', {});
    } else {
      check('a housekeeping line is not tagged as an enrollment', true, 'recording unavailable');
    }

    // A second purchase must announce again — the announcement is per sale, not
    // a one-shot for the room.
    const buyer2 = await register(slug, 'Second Buyer', `second-${Date.now()}@example.com`);
    const order2 = await api('/api/payments/order', {
      method: 'POST',
      token: buyer2.token,
      body: { ctaId },
    });
    const secondAnnouncement = waitFor(hostSocket, 'chatMessage', 6000);
    await api('/api/payments/verify', {
      method: 'POST',
      token: buyer2.token,
      body: {
        razorpayOrderId: order2.json?.orderId,
        razorpayPaymentId: `pay_test2_${Date.now()}`,
        razorpaySignature: `mock_${order2.json?.orderId}`,
      },
    });
    const msg2 = await secondAnnouncement;
    check(
      'a second sale announces again',
      typeof msg2?.text === 'string' && msg2.text.includes('Second Buyer'),
      msg2?.text ?? ''
    );

    // A CTA is allowed to be a price-only offer with no course attached — the
    // ordinary shape for a one-off workshop. The announcement used to be gated
    // on `payment.courseId`, so those buyers paid and the room saw nothing:
    // no chat line, no toast, and no `enrolled` badge either, because
    // `markEnrolled` rides the same event.
    const bareCta = await api(`/api/admin/${id}/ctas`, {
      method: 'POST',
      token,
      body: {
        title: 'Bare Offer',
        buttonText: 'Buy',
        priceOverridePaise: 21000,
      },
    });
    check('admin can create a course-less offer', bareCta.status === 201, String(bareCta.status));
    const bareCtaId = bareCta.json?.cta?.id ?? bareCta.json?.id ?? null;

    const buyer3 = await register(slug, 'Bare Buyer', `bare-${Date.now()}@example.com`);
    const order3 = await api('/api/payments/order', {
      method: 'POST',
      token: buyer3.token,
      body: { ctaId: bareCtaId },
    });
    check('a course-less offer can be ordered', order3.status === 200, String(order3.status));

    const bareAnnouncement = waitFor(hostSocket, 'chatMessage', 6000);
    await api('/api/payments/verify', {
      method: 'POST',
      token: buyer3.token,
      body: {
        razorpayOrderId: order3.json?.orderId,
        razorpayPaymentId: `pay_test3_${Date.now()}`,
        razorpaySignature: `mock_${order3.json?.orderId}`,
      },
    });
    const msg3 = await bareAnnouncement;
    check(
      'a course-less purchase is announced too',
      typeof msg3?.text === 'string' && msg3.text.includes('Bare Buyer'),
      msg3?.text ?? 'timed out'
    );
    check(
      'a course-less announcement falls back to the offer title',
      msg3?.subject === 'Bare Offer',
      String(msg3?.subject)
    );

    await sleep(200);
  } finally {
    hostSocket?.disconnect();
    if (courseId) await api(`/api/admin/courses/${courseId}`, { method: 'DELETE', token });
    await dropWebinar(token, id);
    finish();
  }
});

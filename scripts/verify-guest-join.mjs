/**
 * Verifies the guest-join path and the admin refund path.
 *
 * Both features are gated on webinar configuration, so this script creates its
 * own throwaway webinar rather than mutating the demo one — that way it can run
 * repeatedly without leaving the demo in a strange state.
 *
 * Run with the API on :4000 and the demo seeded:
 *   node scripts/verify-guest-join.mjs
 */
const API = process.env.API_URL ?? 'http://localhost:4000';

let pass = 0;
let fail = 0;

function check(label, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function call(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function main() {
  console.log('\nGuest join + refunds\n');

  // ── Admin login ────────────────────────────────────────────
  const login = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'admin@webinar.local', password: 'Admin@12345' }),
  });
  check('admin can log in', login.status === 200 && Boolean(login.body?.token), `status ${login.status}`);
  const adminToken = login.body?.token;
  const auth = { Authorization: `Bearer ${adminToken}` };

  // ── Create a webinar that does not require registration ────
  const slug = `guest-test-${Date.now()}`;
  const created = await call('/api/admin/webinars', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      title: 'Guest Join Test',
      description: 'Throwaway webinar for the guest-join check.',
      startsAt: new Date(Date.now() + 3600_000).toISOString(),
      durationMins: 30,
      timezone: 'Asia/Kolkata',
      slug,
      settings: {
        allowMic: true,
        allowVideo: true,
        requireRegistration: false,
        requirePayment: false,
        priceInPaise: 0,
        currency: 'INR',
        chatEnabled: true,
        handRaiseEnabled: true,
        maxParticipants: 50,
      },
    }),
  });
  check('admin can create a no-registration webinar', created.status === 200 || created.status === 201, `status ${created.status} ${JSON.stringify(created.body).slice(0, 160)}`);

  const webinarId = created.body?.webinar?.id;
  check('created webinar has an id', Boolean(webinarId));

  // ── Guest join succeeds ────────────────────────────────────
  const guest = await call(`/api/webinars/${slug}/guest`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Curious Guest' }),
  });
  check('guest join returns 200', guest.status === 200, `status ${guest.status} ${JSON.stringify(guest.body).slice(0, 160)}`);
  check('guest join returns a session token', Boolean(guest.body?.token));
  check('guest join returns a join token', Boolean(guest.body?.joinToken));
  check('guest join does not require payment', guest.body?.requiresPayment === false);
  check('guest keeps the supplied name', guest.body?.user?.name === 'Curious Guest', String(guest.body?.user?.name));
  check(
    'guest email is marked as a guest',
    String(guest.body?.user?.email ?? '').startsWith('guest-'),
    String(guest.body?.user?.email)
  );

  // ── Guest token actually works ─────────────────────────────
  const me = await call('/api/auth/me', { headers: { Authorization: `Bearer ${guest.body?.token}` } });
  check('guest token authenticates', me.status === 200 && me.body?.user?.id === guest.body?.user?.id, `status ${me.status}`);

  // ── A registration-required webinar rejects guests ─────────
  const rejected = await call('/api/webinars/live-product-teardown/guest', {
    method: 'POST',
    body: JSON.stringify({ name: 'Should Not Work' }),
  });
  check('guest join is refused when registration is required', rejected.status === 400, `status ${rejected.status}`);

  // ── Refunds ────────────────────────────────────────────────
  // Create a paid webinar and buy a seat through the mock checkout so there is
  // always something to refund, regardless of what earlier runs left behind.
  const paidSlug = `refund-test-${Date.now()}`;
  const paidWebinar = await call('/api/admin/webinars', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      title: 'Refund Test',
      description: 'Throwaway paid webinar for the refund check.',
      startsAt: new Date(Date.now() + 3600_000).toISOString(),
      durationMins: 30,
      timezone: 'Asia/Kolkata',
      slug: paidSlug,
      settings: {
        allowMic: true,
        allowVideo: true,
        requireRegistration: true,
        requirePayment: true,
        priceInPaise: 49900,
        currency: 'INR',
        chatEnabled: true,
        handRaiseEnabled: true,
        maxParticipants: 50,
      },
    }),
  });
  const paidWebinarId = paidWebinar.body?.webinar?.id;
  check('admin can create a paid webinar', Boolean(paidWebinarId), JSON.stringify(paidWebinar.body).slice(0, 160));

  const buyer = await call(`/api/webinars/${paidSlug}/register`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Refund Buyer',
      email: `buyer-${Date.now()}@example.com`,
      // Phone is required since the join link became a lead-capture surface.
      phone: '+91 98765 43210',
    }),
  });
  check('buyer can register for the paid webinar', buyer.status === 200, `status ${buyer.status}`);
  check('buyer is told payment is required', buyer.body?.requiresPayment === true);

  const order = await call('/api/payments/order', {
    method: 'POST',
    headers: { Authorization: `Bearer ${buyer.body?.token}` },
    body: JSON.stringify({ webinarId: paidWebinarId }),
  });
  check('buyer can create an order', order.status === 200 && Boolean(order.body?.orderId), `status ${order.status}`);

  const verify = await call('/api/payments/verify', {
    method: 'POST',
    headers: { Authorization: `Bearer ${buyer.body?.token}` },
    body: JSON.stringify({
      razorpayOrderId: order.body?.orderId,
      razorpayPaymentId: `pay_mock_${Date.now()}`,
      razorpaySignature: `mock_${order.body?.orderId}`,
    }),
  });
  check('mock payment verifies', verify.status === 200 && verify.body?.ok === true, `status ${verify.status} ${JSON.stringify(verify.body).slice(0, 160)}`);

  const payments = await call(`/api/admin/payments?webinarId=${paidWebinarId}`, { headers: auth });
  check('admin can list payments', payments.status === 200 && Array.isArray(payments.body?.payments), `status ${payments.status}`);
  check('the new payment is listed as PAID', payments.body?.payments?.[0]?.status === 'PAID', String(payments.body?.payments?.[0]?.status));

  const allPayments = await call('/api/admin/payments', { headers: auth });
  check('admin can list all payments', allPayments.status === 200 && Array.isArray(allPayments.body?.payments), `status ${allPayments.status}`);

  const paid = (payments.body?.payments ?? []).find((p) => p.status === 'PAID');
  if (paid) {
    const refund = await call(`/api/admin/payments/${paid.id}/refund`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({}),
    });
    check('admin can refund a paid payment', refund.status === 200 && refund.body?.ok === true, `status ${refund.status} ${JSON.stringify(refund.body).slice(0, 160)}`);
    check('refund reports itself as full', refund.body?.full === true);
    check('refund reports the original amount', refund.body?.amountPaise === 49900, String(refund.body?.amountPaise));

    const again = await call(`/api/admin/payments/${paid.id}/refund`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({}),
    });
    check('a refunded payment cannot be refunded twice', again.status === 400, `status ${again.status}`);

    const after = await call(`/api/admin/payments?webinarId=${paidWebinarId}`, { headers: auth });
    const updated = (after.body?.payments ?? []).find((p) => p.id === paid.id);
    check('payment status becomes REFUNDED', updated?.status === 'REFUNDED', String(updated?.status));

    // The seat should no longer be marked paid, so the buyer cannot rejoin.
    const joinToken = buyer.body?.joinToken ?? buyer.body?.registration?.joinToken;
    const rejoin = await call(`/api/webinars/${paidSlug}/join-info?token=${joinToken}`);
    check('a refunded buyer can no longer join', rejoin.status === 400, `status ${rejoin.status}`);
  } else {
    console.log('  SKIP  no PAID payment available to refund');
  }

  // ── Non-admins cannot refund ───────────────────────────────
  const forbidden = await call('/api/admin/payments', {
    headers: { Authorization: `Bearer ${guest.body?.token}` },
  });
  check('a guest cannot read the payments list', forbidden.status === 403 || forbidden.status === 401, `status ${forbidden.status}`);

  // ── Clean up ───────────────────────────────────────────────
  if (webinarId) {
    await call(`/api/admin/webinars/${webinarId}`, { method: 'DELETE', headers: auth });
  }
  if (paidWebinarId) {
    await call(`/api/admin/webinars/${paidWebinarId}`, { method: 'DELETE', headers: auth });
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  // Setting exitCode rather than calling process.exit() lets Node tear down
  // its handles cleanly — an abrupt exit trips a libuv assertion on Windows.
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

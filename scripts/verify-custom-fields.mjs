/**
 * Verifies custom registration fields.
 *
 *   host   : creates text / select / multi-select / checkbox fields
 *   host   : a choice field with no options is rejected
 *   public : GET /:slug/form returns the live field set, ordered
 *   public : a registration carrying answers stores them
 *   public : a missing required answer is rejected with a readable message
 *   public : an unknown field id is ignored, not fatal
 *   host   : deleting a field hides it from the form but keeps the answer row
 *   host   : the CSV export carries one column per field
 */
import {
  API,
  api,
  createChecker,
  dropWebinar,
  login,
  makeWebinar,
  runSuite,
} from './lib/parity-harness.mjs';

runSuite('custom fields', async () => {
  const { check, finish } = createChecker();
  const admin = await login();
  const token = admin.token;

  const webinar = await makeWebinar(token);
  const wid = webinar.id;
  const slug = webinar.slug;
  check('fixture webinar created', Boolean(wid && slug), slug);

  try {
    /* ── create ── */
    const text = await api(`/api/admin/${wid}/custom-fields`, {
      method: 'POST',
      token,
      body: { label: 'Company', type: 'text', isRequired: true },
    });
    check('create a required text field', text.status === 201 && Boolean(text.json?.field?.id));
    const companyId = text.json?.field?.id;

    const select = await api(`/api/admin/${wid}/custom-fields`, {
      method: 'POST',
      token,
      body: {
        label: 'Team size',
        type: 'select',
        options: [{ label: '1-10' }, { label: '11-50' }, { label: '51+' }],
      },
    });
    check(
      'create a select field with options',
      select.status === 201 && select.json?.field?.options?.length === 3,
      JSON.stringify(select.json?.field?.options?.length)
    );
    const teamId = select.json?.field?.id;

    const multi = await api(`/api/admin/${wid}/custom-fields`, {
      method: 'POST',
      token,
      body: {
        label: 'Interests',
        type: 'multi-select',
        options: [{ label: 'AI' }, { label: 'Infra' }],
      },
    });
    check('create a multi-select field', multi.status === 201);
    const interestsId = multi.json?.field?.id;

    const consent = await api(`/api/admin/${wid}/custom-fields`, {
      method: 'POST',
      token,
      body: { label: 'I agree to be recorded', type: 'checkbox', isRequired: true },
    });
    check('create a checkbox field', consent.status === 201);
    const consentId = consent.json?.field?.id;

    /* ── validation ── */
    const noOptions = await api(`/api/admin/${wid}/custom-fields`, {
      method: 'POST',
      token,
      body: { label: 'Broken', type: 'select' },
    });
    check('a choice field with no options is rejected', noOptions.status === 400);

    const badType = await api(`/api/admin/${wid}/custom-fields`, {
      method: 'POST',
      token,
      body: { label: 'Broken', type: 'not-a-type' },
    });
    check('an unknown field type is rejected', badType.status === 400);

    /* ── public form ── */
    const form = await api(`/api/webinars/${slug}/form`);
    check('the public form is reachable without auth', form.status === 200);
    const fields = form.json?.fields ?? [];
    check('the form lists every live field', fields.length === 4, `got ${fields.length}`);
    check(
      'the form is ordered',
      fields.every((f, i) => i === 0 || fields[i - 1].order <= f.order)
    );
    check(
      'the form carries the options',
      (fields.find((f) => f.id === teamId)?.options ?? []).length === 3
    );

    /* ── registration with answers ── */
    const stamp = Date.now();
    const ok = await api(`/api/webinars/${slug}/register`, {
      method: 'POST',
      body: {
        name: 'Field Tester',
        email: `fieldtester${stamp}@example.com`,
        phone: '+91 98765 43210',
        customResponses: {
          [companyId]: 'Acme Corp',
          [teamId]: '11-50',
          [interestsId]: ['AI', 'Infra'],
          [consentId]: true,
        },
      },
    });
    check('a registration with answers is accepted', ok.status === 200, ok.text?.slice(0, 120));

    const missing = await api(`/api/webinars/${slug}/register`, {
      method: 'POST',
      body: {
        name: 'Field Skipper',
        email: `fieldskipper${stamp}@example.com`,
        phone: '+91 98765 43210',
        customResponses: { [teamId]: '1-10' },
      },
    });
    check('a missing required answer is rejected', missing.status === 400);
    check(
      'the rejection names the field',
      typeof missing.json?.error === 'string' && /Company/i.test(missing.json.error),
      missing.json?.error
    );

    const unknown = await api(`/api/webinars/${slug}/register`, {
      method: 'POST',
      body: {
        name: 'Field Extra',
        email: `fieldextra${stamp}@example.com`,
        phone: '+91 98765 43210',
        customResponses: {
          [companyId]: 'Acme',
          [consentId]: true,
          'not-a-real-field': 'ignored',
        },
      },
    });
    check('an unknown field id is ignored, not fatal', unknown.status === 200);

    const badEmail = await api(`/api/admin/${wid}/custom-fields`, {
      method: 'POST',
      token,
      body: { label: 'Contact', type: 'email' },
    });
    const emailId = badEmail.json?.field?.id;
    const badValue = await api(`/api/webinars/${slug}/register`, {
      method: 'POST',
      body: {
        name: 'Field Bad',
        email: `fieldbad${stamp}@example.com`,
        phone: '+91 98765 43210',
        customResponses: { [companyId]: 'Acme', [consentId]: true, [emailId]: 'not-an-email' },
      },
    });
    check('a malformed email answer is rejected', badValue.status === 400);

    /* ── the admin view carries the answers ── */
    const regs = await api(`/api/admin/${wid}/registrations`, { token });
    const tester = (regs.json?.registrations ?? []).find((r) =>
      r.email.startsWith('fieldtester')
    );
    check('the admin list shows the registration', Boolean(tester));
    check(
      'the answers are attached to the row',
      (tester?.responses ?? []).length === 4,
      `got ${tester?.responses?.length}`
    );
    const companyAnswer = (tester?.responses ?? []).find((r) => r.fieldId === companyId);
    check('an answer carries its label and value', companyAnswer?.value === 'Acme Corp');

    /* ── CSV export ── */
    const csv = await fetch(`${API}/api/admin/${wid}/registrations/export`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await csv.text();
    check('the CSV export succeeds', csv.status === 200);
    check('the CSV has a column per field', /Company/.test(body) && /Team size/.test(body));
    check('the CSV carries the answer', /Acme Corp/.test(body));

    /* ── delete ── */
    const del = await api(`/api/admin/custom-fields/${teamId}`, { method: 'DELETE', token });
    check('a field can be deleted', del.status === 200);

    const after = await api(`/api/webinars/${slug}/form`);
    check(
      'a deleted field leaves the form',
      !(after.json?.fields ?? []).some((f) => f.id === teamId)
    );

    const regsAfter = await api(`/api/admin/${wid}/registrations`, { token });
    const testerAfter = (regsAfter.json?.registrations ?? []).find((r) =>
      r.email.startsWith('fieldtester')
    );
    check(
      'the stored answer survives the field deletion',
      (testerAfter?.responses ?? []).some((r) => r.fieldId === teamId),
      'answers are kept for audit'
    );
  } finally {
    await dropWebinar(token, wid);
  }

  finish();
});

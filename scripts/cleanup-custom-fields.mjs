/**
 * Removes the custom fields that earlier smoke runs left behind.
 *
 * The smoke test used to delete only the first of the two fields it created, so
 * every run added a "Team size" row to the demo webinar. This is a one-off
 * cleanup, not part of the suite.
 */
const API = 'http://localhost:4000';

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

const login = await api('/api/auth/login', {
  method: 'POST',
  body: { email: 'admin@webinar.local', password: 'Admin@12345' },
});
if (login.status !== 200) {
  console.error('login failed', login.status, login.json);
  process.exitCode = 1;
} else {
  const token = login.json.token;
  const list = await api('/api/admin/webinars', { token });
  const webinar = (list.json?.webinars ?? []).find((w) => w.slug === 'live-product-teardown');
  if (!webinar) {
    console.error('demo webinar not found');
    process.exitCode = 1;
  } else {
    const fields = await api(`/api/admin/${webinar.id}/custom-fields`, { token });
    const rows = fields.json?.fields ?? [];
    console.log(`found ${rows.length} field(s)`);
    let removed = 0;
    for (const field of rows) {
      const res = await api(`/api/admin/custom-fields/${field.id}`, {
        method: 'DELETE',
        token,
      });
      console.log(`  delete ${field.label} (${field.id}) -> ${res.status}`);
      if (res.status === 200) removed += 1;
    }
    console.log(`removed ${removed}`);
  }
}

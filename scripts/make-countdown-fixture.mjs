/**
 * Creates a SCHEDULED webinar starting in the future, plus a registered
 * participant, so the waiting-room countdown can be checked in a browser.
 *
 * Prints the slug and the participant's JWT. Run it, open
 * http://localhost:3000/room/<slug> with the token in localStorage, and the
 * waiting room should show a countdown rather than "starting shortly".
 */
import { api, login, makeWebinar, register } from './lib/parity-harness.mjs';

const { token } = await login();

// Two hours out, so the countdown has something to count.
const startsAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

const webinar = await makeWebinar(token, {
  title: `Countdown Fixture ${Date.now()}`,
  startsAt,
  status: 'SCHEDULED',
});

const slug = webinar.slug;
const reg = await register(slug, 'Countdown Viewer', `countdown-${Date.now()}@example.com`);
console.log(JSON.stringify({ id: webinar.id, slug, startsAt, jwt: reg.token }, null, 2));

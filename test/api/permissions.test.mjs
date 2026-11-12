// Who may do what, checked against a running server (`npm run dev`, or the
// one CI starts):  BASE=http://127.0.0.1:8787 npm run test:api
//
// For each set of settings and each kind of caller, every change the API has
// is tried on a fresh event, and the answer compared with the table in
// expected() below. That table is written out by hand on purpose: it doesn't
// use the can* functions the server decides with, so a slip in them shows up
// here.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const DAY = 864e5;
const day = (n) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
const DAYS = [day(10), day(11), day(12)];

async function call(method, path, token, body) {
  const headers = { 'x-dev-ip': ip() };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}/api/events${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const ok = async (...args) => {
  const r = await call(...args);
  assert.equal(r.status, 200, `setup ${args[0]} ${args[1]}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
};

const SETTINGS = { maybe: true, maybeCounts: false, openEdit: false, hidden: false, closed: false, newNames: true, claims: true, rename: true, decide: false, details: false };
const SCENARIOS = {
  defaults: {},
  closed: { closed: true },
  hidden: { hidden: true },
  'only listed names': { newNames: false },
  'no claims': { claims: false },
  'no renaming': { rename: false },
  'open edit': { openEdit: true },
  'anyone decides': { decide: true },
  'anyone changes details': { details: true },
  'hidden, with open edit and decide set': { hidden: true, openEdit: true, decide: true },
  'closed, with everything else on': { closed: true, openEdit: true, decide: true, details: true },
  'only listed names, no claims': { newNames: false, claims: false },
};
// visitor: no link. bad: not shaped like a link. stale: a link that was
// replaced. Those three are all visitors to the server.
const ROLES = ['visitor', 'bad', 'stale', 'participant', 'admin'];

// The status each action should get.
function expected(action, role, s) {
  const admin = role === 'admin';
  const me = role === 'participant';
  const yes = (allowed) => (allowed ? 200 : 403);
  switch (action) {
    case 'add a new name':
      return yes(admin || (!s.closed && s.newNames));
    case 'answer as a listed name':
      // The admin answers for a name by changing its entry instead.
      return yes(!admin && !me && !s.closed && !s.hidden && s.claims);
    case "change one's own answers":
      return yes(!s.closed);
    case "change another's answers":
    case "delete another's entry":
      return yes(admin || (!s.closed && s.openEdit && !s.hidden));
    case "rename another's entry":
      return yes(admin || (!s.closed && s.openEdit && !s.hidden && s.rename));
    case "rename one's own entry":
      return yes(!s.closed && s.rename);
    case 'delete a listed name':
      return yes(admin);
    case 'pick the final day':
      return yes(admin || (s.decide && !s.closed && !s.hidden));
    case 'change the name of the event':
      return yes(admin || (s.details && !s.closed));
    case "get one's own link again":
      return 200;
    case "get another's link":
    case 'list names':
    case 'change the event':
    case 'make a new admin link':
    case 'delete the event':
      return yes(admin);
    default:
      throw new Error(`no expectation for ${action}`);
  }
}

// A fresh event with Anne and Berit answered (Anne with an email), two
// listed names waiting, and then the scenario's settings.
async function setup(settings) {
  const event = { name: 'Rettigheter', mode: 'dates', start: DAYS[0], end: DAYS[2], options: DAYS, settings: SETTINGS };
  const made = await ok('POST', '', null, { event, emails: ['boss@example.com'] });
  const anne = await ok('POST', `/${made.id}/people`, null, { name: 'Anne', email: 'anne@example.com', answers: { [DAYS[0]]: 1 } });
  const berit = await ok('POST', `/${made.id}/people`, null, { name: 'Berit', answers: { [DAYS[1]]: 1 } });
  const listed = await ok('POST', `/${made.id}/invite`, made.token, { names: ['Carl', 'Dina'] });
  const [carl, dina] = listed.view.waiting;
  await ok('PUT', `/${made.id}`, made.token, { event: { ...event, settings: { ...SETTINGS, ...settings } } });
  return { id: made.id, event, admin: made.token, anne, berit, carl, dina };
}

for (const [scenario, change] of Object.entries(SCENARIOS)) {
  const s = { ...SETTINGS, ...change };
  for (const role of ROLES) {
    test(`${scenario}: ${role}`, async () => {
      const e = await setup(change);
      const stale = e.anne.token.slice(0, -1) + (e.anne.token.endsWith('A') ? 'B' : 'A');
      const token = { visitor: null, bad: 'not-a-link', stale, participant: e.anne.token, admin: e.admin }[role];
      const me = role === 'participant';
      const p = `/${e.id}`;
      const step = async (action, method, path, body) => {
        const r = await call(method, `${p}${path}`, token, body);
        assert.equal(r.status, expected(action, role, s), `${action}: got ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
        return r;
      };

      // What the caller gets to see.
      const { view } = await ok('GET', p, token);
      assert.equal(view.role, role === 'admin' ? 'admin' : me ? 'participant' : 'visitor');
      assert.equal(view.link, { visitor: 'none', bad: 'invalid', stale: 'invalid', participant: 'ok', admin: 'ok' }[role]);
      const sees = role === 'admin' || !s.hidden;
      assert.deepEqual(view.people.map((x) => x.name).sort(), sees ? ['Anne', 'Berit'] : me ? ['Anne'] : [], 'whose answers are shown');
      assert.equal(view.count, sees ? 2 : undefined, 'how many have answered');
      assert.equal(view.waiting.length, sees ? 2 : 0, 'the names still waiting');
      assert.equal(view.adminEmails?.[0], role === 'admin' ? 'boss@example.com' : undefined, "the organisers' addresses");
      const text = JSON.stringify(view);
      assert.equal(text.includes('anne@example.com'), me, "Anne's address is only hers to see");
      assert.equal(text.includes('boss@example.com'), role === 'admin');
      for (const secret of [e.admin.slice(16), e.anne.token.slice(16), e.berit.token.slice(16)]) assert.equal(text.includes(secret), false, 'no link secret in a view');

      await step('add a new name', 'POST', '/people', { name: 'Nykommer', answers: {} });
      await step('answer as a listed name', 'POST', '/people', { name: 'Carl', answers: {}, claim: e.carl.id });
      if (me) {
        await step("change one's own answers", 'PUT', `/people/${e.anne.pid}`, { name: 'Anne', email: 'anne@example.com', answers: { [DAYS[2]]: 1 } });
        await step("rename one's own entry", 'PUT', `/people/${e.anne.pid}`, { name: 'Anne K.', email: 'anne@example.com', answers: {} });
        await step("get one's own link again", 'POST', `/people/${e.anne.pid}/link`, {});
      }
      await step("change another's answers", 'PUT', `/people/${e.berit.pid}`, { name: 'Berit', answers: { [DAYS[0]]: 2 } });
      await step("rename another's entry", 'PUT', `/people/${e.berit.pid}`, { name: 'Berit B.', answers: {} });
      await step("get another's link", 'POST', `/people/${e.berit.pid}/link`, {});
      await step('pick the final day', 'POST', '/decide', { decided: DAYS[1] });
      await step('change the name of the event', 'PUT', '/details', { name: 'Nytt navn' });
      await step('list names', 'POST', '/invite', { names: ['Even'] });
      await step('delete a listed name', 'DELETE', `/people/${e.dina.id}`);
      await step("delete another's entry", 'DELETE', `/people/${e.berit.pid}`);
      await step('change the event', 'PUT', '', { event: { ...e.event, name: 'Endret', settings: { ...s } } });
      await step('make a new admin link', 'POST', '/admin-link', {});
      // Last: with the admin's link the one before was just replaced.
      const gone = await call('DELETE', p, token);
      assert.equal(gone.status, 403, 'the replaced admin link, or no admin link, deletes nothing');
      const still = await call('GET', p, null);
      assert.equal(still.status, 200, 'the event is still there');
    });
  }
}

test('the admin link deletes the event, and then it is gone', async () => {
  const e = await setup({});
  assert.equal((await call('DELETE', `/${e.id}`, e.anne.token)).status, 403);
  assert.equal((await call('DELETE', `/${e.id}`, e.admin)).status, 200);
  assert.equal((await call('GET', `/${e.id}`, null)).status, 404);
  assert.equal((await call('GET', `/${e.id}`, e.admin)).status, 404);
});

test('a reset link stops working, the new one works', async () => {
  const e = await setup({});
  const { token } = await ok('POST', `/${e.id}/people/${e.anne.pid}/link`, e.anne.token, { reset: true });
  assert.notEqual(token, e.anne.token);
  assert.equal((await ok('GET', `/${e.id}`, e.anne.token)).view.link, 'invalid');
  assert.equal((await ok('GET', `/${e.id}`, token)).view.role, 'participant');
  const next = await ok('POST', `/${e.id}/admin-link`, e.admin, {});
  assert.equal((await ok('GET', `/${e.id}`, e.admin)).view.role, 'visitor');
  assert.equal((await ok('GET', `/${e.id}`, next.token)).view.role, 'admin');
});

test("one person's link is no use on another event", async () => {
  const a = await setup({});
  const b = await setup({});
  assert.equal((await ok('GET', `/${b.id}`, a.admin)).view.role, 'visitor');
  assert.equal((await ok('GET', `/${b.id}`, a.anne.token)).view.role, 'visitor');
  assert.equal((await call('DELETE', `/${b.id}`, a.admin)).status, 403);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newPid, newSecret, token, parse, same, TOKEN_RE, PID_RE } from '../src/worker/link.ts';

test('a token is a participant id and a 22-character secret, 38 URL-safe characters', () => {
  const pid = newPid();
  const secret = newSecret();
  assert.match(pid, PID_RE);
  assert.match(secret, /^[A-Za-z0-9_-]{22}$/);
  const t = token(pid, secret);
  assert.equal(t.length, 38);
  assert.match(t, TOKEN_RE);
  assert.deepEqual(parse(t), { sel: pid, secret });
});

test('secrets and ids are random', () => {
  const secrets = new Set(Array.from({ length: 1000 }, newSecret));
  const pids = new Set(Array.from({ length: 1000 }, newPid));
  assert.equal(secrets.size, 1000);
  assert.equal(pids.size, 1000);
});

test('anything not shaped like a token is refused', () => {
  const t = token(newPid(), newSecret());
  for (const bad of [undefined, null, 42, '', 'short', t + 'x', t.slice(1), t.toUpperCase().replace(/^[0-9A-F]{16}/, 'ABCDEF0123456789'), '!'.repeat(38)]) {
    assert.equal(parse(bad), null, String(bad));
  }
});

test('same() compares strings exactly', () => {
  const s = newSecret();
  assert.ok(same(s, s.slice()));
  assert.ok(!same(s, s.slice(0, -1) + (s.endsWith('A') ? 'B' : 'A')));
  assert.ok(!same(s, s.slice(1)));
  assert.ok(!same(s, null));
  assert.ok(!same(undefined, undefined));
});

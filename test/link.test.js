import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seal, open, newPid, TOKEN_RE, usableSecret } from '../src/link.js';

const SECRET = 'x'.repeat(40);

test('a participant link round-trips and is 56 URL-safe characters', async () => {
  const pid = newPid();
  const token = await seal(SECRET, 'AbCdEfGhIjKl', { role: 'participant', gen: 3, pid });
  assert.match(token, TOKEN_RE);
  assert.deepEqual(await open(SECRET, 'AbCdEfGhIjKl', token), { role: 'participant', gen: 3, pid });
});

test('an admin link round-trips; two seals of the same thing differ', async () => {
  const a = await seal(SECRET, 'AbCdEfGhIjKl', { role: 'admin', gen: 1 });
  const b = await seal(SECRET, 'AbCdEfGhIjKl', { role: 'admin', gen: 1 });
  assert.notEqual(a, b);
  assert.deepEqual(await open(SECRET, 'AbCdEfGhIjKl', a), { role: 'admin', gen: 1 });
});

test('a link only opens on its own event, with the right key, untampered', async () => {
  const token = await seal(SECRET, 'AbCdEfGhIjKl', { role: 'admin', gen: 1 });
  assert.equal(await open(SECRET, 'AbCdEfGhIjKm', token), null);
  assert.equal(await open('y'.repeat(40), 'AbCdEfGhIjKl', token), null);
  const flipped = token.slice(0, 20) + (token[20] === 'A' ? 'B' : 'A') + token.slice(21);
  assert.equal(await open(SECRET, 'AbCdEfGhIjKl', flipped), null);
  assert.equal(await open(SECRET, 'AbCdEfGhIjKl', 'short'), null);
  assert.equal(await open(SECRET, 'AbCdEfGhIjKl', '!'.repeat(56)), null);
});

test('no usable secret: sealing refuses, opening says no', async () => {
  assert.ok(!usableSecret(undefined));
  assert.ok(!usableSecret('short'));
  await assert.rejects(seal('short', 'AbCdEfGhIjKl', { role: 'admin', gen: 1 }));
  const token = await seal(SECRET, 'AbCdEfGhIjKl', { role: 'admin', gen: 1 });
  assert.equal(await open(undefined, 'AbCdEfGhIjKl', token), null);
});

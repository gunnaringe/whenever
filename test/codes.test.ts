import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADDRESS_RULES, IP_RULES, MINUTE, HOUR, DAY, allowedAt, waitWord, newCode, cleanCode, dailyMax, DAILY_MAX, newLinkToken, cleanLinkToken, LINK_RE } from '../src/worker/codes.ts';

const now = 1_800_000_000_000;

test('an address may ask once a minute', () => {
  assert.equal(allowedAt([], ADDRESS_RULES, now), 0);
  assert.equal(allowedAt([now - 10_000], ADDRESS_RULES, now), now - 10_000 + MINUTE);
  assert.equal(allowedAt([now - MINUTE - 1], ADDRESS_RULES, now), 0);
});

test('an address may ask three times an hour', () => {
  const asks = [now - 50 * MINUTE, now - 30 * MINUTE, now - 10 * MINUTE];
  assert.equal(allowedAt(asks, ADDRESS_RULES, now), now - 50 * MINUTE + HOUR);
  assert.equal(waitWord(allowedAt(asks, ADDRESS_RULES, now) - now), 'hour');
  assert.equal(allowedAt(asks.slice(1), ADDRESS_RULES, now), 0);
});

test('an address may ask six times a day', () => {
  const asks = [12, 10, 8, 6, 4, 2].map((h) => now - h * HOUR);
  assert.equal(allowedAt(asks, ADDRESS_RULES, now), now - 12 * HOUR + DAY);
  assert.equal(waitWord(allowedAt(asks, ADDRESS_RULES, now) - now), 'day');
  assert.equal(allowedAt(asks.slice(1), ADDRESS_RULES, now), 0);
});

test('an IP may ask twenty times a day', () => {
  const asks = Array.from({ length: 20 }, (_, i) => now - (i + 1) * HOUR);
  assert.ok(allowedAt(asks, IP_RULES, now) > now);
  assert.equal(allowedAt(asks.slice(1), IP_RULES, now), 0);
  assert.equal(allowedAt(asks.map((t) => t - DAY), IP_RULES, now), 0, 'yesterday’s asks no longer count');
});

test('the wait is a minute, an hour or a day', () => {
  assert.equal(waitWord(30_000), 'minute');
  assert.equal(waitWord(MINUTE), 'minute');
  assert.equal(waitWord(20 * MINUTE), 'hour');
  assert.equal(waitWord(5 * HOUR), 'day');
});

test('codes are six digits and random', () => {
  const codes = Array.from({ length: 2000 }, newCode);
  for (const c of codes) assert.match(c, /^\d{6}$/);
  assert.ok(new Set(codes).size > 1990);
  assert.ok(codes.some((c) => c.startsWith('0')), 'leading zeros happen');
});

test('a typed code may have spaces or a dash', () => {
  assert.equal(cleanCode('123456'), '123456');
  assert.equal(cleanCode(' 123 456 '), '123456');
  assert.equal(cleanCode('123-456'), '123456');
  for (const bad of ['12345', '1234567', 'abcdef', 123456, null, undefined]) assert.equal(cleanCode(bad), null, String(bad));
});

test('the daily mail cap comes from MAIL_DAILY_MAX, else the default', () => {
  assert.equal(dailyMax('50'), 50);
  assert.equal(dailyMax(undefined), DAILY_MAX);
  assert.equal(dailyMax('0'), DAILY_MAX);
  assert.equal(dailyMax('lots'), DAILY_MAX);
});

test('link tokens are 32 base64url characters, and differ', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const t = newLinkToken();
    assert.match(t, LINK_RE);
    seen.add(t);
  }
  assert.equal(seen.size, 200);
});

test('only a well-formed link token is taken', () => {
  const t = newLinkToken();
  assert.equal(cleanLinkToken(t), t);
  assert.equal(cleanLinkToken(`${t}x`), null);
  assert.equal(cleanLinkToken(t.slice(1)), null);
  assert.equal(cleanLinkToken(`${t.slice(1)}=`), null);
  assert.equal(cleanLinkToken(42), null);
});

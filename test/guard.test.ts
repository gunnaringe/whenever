import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SOCKETS, evict, plainHttp, readCapped } from '../src/worker/guard.ts';

test('plain http from outside this machine, and nothing else', () => {
  const http = new URL('http://finn-tid.apphub.casa/e/AbC123dEf456');
  const https = new URL('https://finn-tid.apphub.casa/e/AbC123dEf456');
  assert.equal(plainHttp(http, '203.0.113.7'), true);
  assert.equal(plainHttp(http, '2001:db8::1'), true);
  assert.equal(plainHttp(http, null), true, 'no address is not this machine');
  assert.equal(plainHttp(https, '203.0.113.7'), false);
  // wrangler dev: plain http on loopback.
  assert.equal(plainHttp(http, '127.0.0.1'), false);
  assert.equal(plainHttp(http, '::1'), false);
});

const post = (body: string | ReadableStream<Uint8Array>, headers: Record<string, string> = {}) => new Request('https://x.test/', { method: 'POST', body, headers, duplex: 'half' } as RequestInit);

// A body that arrives in pieces and says nothing about its length.
function pieces(sizes: number[], onPull: () => void = () => {}): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(c) {
      onPull();
      if (i < sizes.length) c.enqueue(new Uint8Array(sizes[i++]).fill(97));
      else c.close();
    },
  });
}

test('a body within the limit is read whole', async () => {
  assert.equal(await readCapped(post('{"name":"Blåbærtur"}'), 100), '{"name":"Blåbærtur"}');
  assert.equal(await readCapped(post(pieces([3, 4])), 7), 'aaaaaaa');
  assert.equal(await readCapped(new Request('https://x.test/'), 100), '', 'no body');
});

test('a body over the limit is dropped, whatever it says about its length', async () => {
  assert.equal(await readCapped(post('x'.repeat(11)), 10), null);
  assert.equal(await readCapped(post('x', { 'content-length': '5000' }), 10), null, 'by its content-length alone');
  // Bytes, not characters.
  assert.equal(await readCapped(post('ååååå'), 9), null);
  // No content-length: it stops reading soon after the limit, not at the end.
  let pulls = 0;
  assert.equal(await readCapped(post(pieces(Array<number>(1000).fill(8), () => pulls++)), 20), null);
  assert.ok(pulls < 20, `read ${pulls} pieces of 1000`);
});

test('at the limit, the socket heard from longest ago makes room', () => {
  const at = (s: { at: number }) => s.at;
  const socks = [{ at: 50 }, { at: 0 }, { at: 30 }, { at: 0 }, { at: 40 }];
  assert.deepEqual(evict(socks, at, 6), [], 'room for one more');
  assert.deepEqual(evict(socks, at, 5), [{ at: 0 }], 'one that never said hello goes first');
  assert.deepEqual(evict(socks, at, 3), [{ at: 0 }, { at: 0 }, { at: 30 }]);
  assert.deepEqual(evict([], at, 5), []);
  assert.equal(evict(Array.from({ length: MAX_SOCKETS }, (_, i) => ({ at: i + 1 })), at).length, 1);
  assert.equal(evict(Array.from({ length: MAX_SOCKETS - 1 }, (_, i) => ({ at: i + 1 })), at).length, 0);
});

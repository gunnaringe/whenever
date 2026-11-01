import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAIL_LANGS, codeMail, message, headerText, sendMail, SmtpError, Replies } from '../src/worker/mail.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
const FROM = 'whenever@apphub.casa';

test('the code mail has the code and no links, in every language', () => {
  for (const l of MAIL_LANGS) {
    const m = codeMail(l, '042137', FROM, 'kari@example.com');
    assert.ok(m.subject.includes('042137'), l);
    assert.ok(m.text.includes('042137'), l);
    assert.ok(m.text.includes('10'), l);
    assert.ok(!/https?:|www\./.test(m.text), l);
    assert.equal(m.from, FROM);
  }
});

test('long or non-ASCII headers are encoded words of at most 75 characters', () => {
  assert.equal(headerText('Plain subject'), 'Plain subject');
  const h = headerText('042137 er kóðinn þinn fyrir Finna tíma – og þetta er löng lína til að prófa skiptinguna');
  const words = h.split('\r\n ');
  assert.ok(words.length > 1);
  let back = '';
  for (const w of words) {
    assert.ok(w.length <= 75, w);
    const m = /^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/.exec(w);
    assert.ok(m, w);
    back += Buffer.from(m[1], 'base64').toString('utf8');
  }
  assert.equal(back, '042137 er kóðinn þinn fyrir Finna tíma – og þetta er löng lína til að prófa skiptinguna');
});

test('the message uses CRLF, a +0000 date and a base64 body', () => {
  const m = codeMail('is', '042137', FROM, 'kari@example.com');
  const raw = message(m, new Date(Date.UTC(2026, 10, 1, 12, 0, 0)), 'abc');
  assert.ok(!/[^\r]\n/.test(raw), 'every line ends in CRLF');
  const [head, body] = raw.split('\r\n\r\n');
  assert.match(head, /^Date: Sun, 01 Nov 2026 12:00:00 \+0000$/m);
  assert.match(head, /^From: =\?UTF-8\?B\?[^?]+\?= <whenever@apphub\.casa>$/m);
  assert.match(head, /^Message-ID: <abc@apphub\.casa>$/m);
  for (const line of raw.split('\r\n')) assert.ok(line.length <= 78, line);
  assert.equal(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'), m.text.replace(/\n/g, '\r\n'));
  assert.match(message(codeMail('en', '1', FROM, 'a@b.c')), /^From: "Whenever" <whenever@apphub\.casa>\r$/m);
});

// A scripted SMTP server on a pair of streams. Replies go out in 3-byte
// pieces, so the client has to put lines together.
function server(answer: (cmd: string) => string) {
  const toServer = new TransformStream<Uint8Array, Uint8Array>();
  const toClient = new TransformStream<Uint8Array, Uint8Array>();
  const seen: string[] = [];
  let data = '';
  const done = (async () => {
    const w = toClient.writable.getWriter();
    const send = async (s: string) => {
      const b = enc.encode(s);
      for (let i = 0; i < b.length; i += 3) await w.write(b.slice(i, i + 3)).catch(() => {});
    };
    await send('220 smtp.test ESMTP\r\n');
    const r = toServer.readable.getReader();
    let buf = '';
    let inData = false;
    for (;;) {
      const { value, done } = await r.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) break;
          data = buf.slice(0, end);
          buf = buf.slice(end + 5);
          inData = false;
          await send(answer('.'));
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) break;
        const cmd = buf.slice(0, i);
        buf = buf.slice(i + 2);
        seen.push(cmd);
        if (cmd === 'DATA') inData = true;
        await send(answer(cmd));
        if (cmd === 'QUIT') {
          // The client may already have hung up.
          await w.close().catch(() => {});
          return;
        }
      }
    }
  })();
  return { io: { readable: toClient.readable, writable: toServer.writable }, seen, data: () => data, done };
}

const happy = (cmd: string): string => {
  if (cmd.startsWith('EHLO')) return '250-smtp.test hello\r\n250-PIPELINING\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 1000\r\n';
  if (cmd.startsWith('AUTH')) return '235 2.7.0 ok\r\n';
  if (cmd === 'DATA') return '354 go ahead\r\n';
  if (cmd === 'QUIT') return '221 bye\r\n';
  return '250 ok\r\n';
};

test('sendMail logs in and sends the message', async () => {
  const s = server(happy);
  const mail = codeMail('nb', '123456', FROM, 'kari@example.com');
  await sendMail(s.io, { user: FROM, pass: 'pw' }, mail);
  await s.done;
  assert.deepEqual(s.seen, [
    'EHLO apphub.casa',
    `AUTH PLAIN ${Buffer.from(`\0${FROM}\0pw`).toString('base64')}`,
    `MAIL FROM:<${FROM}>`,
    'RCPT TO:<kari@example.com>',
    'DATA',
    'QUIT',
  ]);
  assert.match(s.data(), /^Subject: 123456 er koden din i Finn tid$/m);
});

test('a refused login fails at the auth step', async () => {
  const s = server((cmd) => (cmd.startsWith('AUTH') ? '535 5.7.8 bad credentials\r\n' : happy(cmd)));
  await assert.rejects(sendMail(s.io, { user: FROM, pass: 'wrong' }, codeMail('en', '123456', FROM, 'kari@example.com')), (e: unknown) => {
    assert.ok(e instanceof SmtpError);
    assert.equal(e.step, 'auth');
    assert.equal(e.code, 535);
    return true;
  });
});

test('errors never carry the address', async () => {
  const s = server((cmd) => (cmd.startsWith('RCPT') ? '550 5.1.1 <kari@example.com> no such user\r\n' : happy(cmd)));
  await assert.rejects(sendMail(s.io, { user: FROM, pass: 'pw' }, codeMail('en', '123456', FROM, 'kari@example.com')), (e: unknown) => {
    assert.ok(e instanceof SmtpError);
    assert.equal(e.step, 'rcpt');
    assert.ok(!e.message.includes('kari'), e.message);
    return true;
  });
});

test('an address that can’t go in <...> is not sent', async () => {
  const s = server(happy);
  await assert.rejects(sendMail(s.io, { user: FROM, pass: 'pw' }, codeMail('en', '123456', FROM, 'a>b@example.com')), /address/);
});

test('replies split anywhere, multi-line in one piece, or bare LF are read', async () => {
  const chunks = ['2', '20 hi\r', '\n250-a\r\n250-b\r\n250 c\r\n', '354 go\n'];
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      for (const x of chunks) c.enqueue(enc.encode(x));
      c.close();
    },
  });
  const r = new Replies(readable);
  assert.deepEqual(await r.next(), { code: 220, text: 'hi' });
  assert.deepEqual(await r.next(), { code: 250, text: 'a b c' });
  assert.deepEqual(await r.next(), { code: 354, text: 'go' });
  await assert.rejects(r.next(), /closed/);
});

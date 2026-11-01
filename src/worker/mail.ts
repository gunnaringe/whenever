// The code mail: its text in each language, the message, and a small SMTP
// client (AUTH PLAIN over a TLS socket the caller opens). The client works on
// any pair of byte streams, so the tests drive it without a network.
//
// Mail goes through Forward Email (smtp.forwardemail.net:465) as SMTP_USER,
// which is also the From address, so SPF/DKIM/DMARC line up for apphub.casa.

export const SMTP_HOST = 'smtp.forwardemail.net';
export const SMTP_PORT = 465;
export const CODE_MINUTES = 10;

export const MAIL_LANGS = ['nb', 'nn', 'sv', 'da', 'is', 'en'] as const;
export type MailLang = (typeof MAIL_LANGS)[number];
export const isMailLang = (v: unknown): v is MailLang => typeof v === 'string' && (MAIL_LANGS as readonly string[]).includes(v);

export interface Mail {
  fromName: string;
  from: string;
  to: string;
  subject: string;
  text: string;
}

export interface Duplex {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

// --- Text ------------------------------------------------------------------------------

const NB_HOST = 'finn-tid.apphub.casa';
const TEXT: Record<MailLang, { app: string; host: string; subject: string; body: string }> = {
  nb: {
    app: 'Finn tid',
    host: NB_HOST,
    subject: '{code} er koden din i Finn tid',
    body: 'Koden for å finne avtalene dine i Finn tid er:\n\n{code}\n\nDen virker i {min} minutter. Har du ikke bedt om den, kan du se bort fra denne e-posten.',
  },
  nn: {
    app: 'Finn tid',
    host: NB_HOST,
    subject: '{code} er koden din i Finn tid',
    body: 'Koden for å finne avtalane dine i Finn tid er:\n\n{code}\n\nDen verkar i {min} minutt. Har du ikkje bede om koden, kan du sjå bort frå denne e-posten.',
  },
  sv: {
    app: 'Hitta tid',
    host: NB_HOST,
    subject: '{code} är din kod för Hitta tid',
    body: 'Koden för att hitta dina träffar i Hitta tid är:\n\n{code}\n\nDen gäller i {min} minuter. Om du inte har bett om den kan du bortse från det här mejlet.',
  },
  da: {
    app: 'Find tid',
    host: NB_HOST,
    subject: '{code} er din kode til Find tid',
    body: 'Koden til at finde dine aftaler i Find tid er:\n\n{code}\n\nDen gælder i {min} minutter. Har du ikke bedt om den, kan du se bort fra denne e-mail.',
  },
  is: {
    app: 'Finna tíma',
    host: NB_HOST,
    subject: '{code} er kóðinn þinn fyrir Finna tíma',
    body: 'Kóðinn til að finna viðburðina þína í Finna tíma er:\n\n{code}\n\nHann gildir í {min} mínútur. Ef þú baðst ekki um hann geturðu hunsað þennan tölvupóst.',
  },
  en: {
    app: 'Whenever',
    host: 'whenever.apphub.casa',
    subject: '{code} is your Whenever code',
    body: 'Your code for finding your events in Whenever is:\n\n{code}\n\nIt works for {min} minutes. If you didn’t ask for it, you can ignore this email.',
  },
};

// Only the code: no event names and no links.
export function codeMail(lang: MailLang, code: string, from: string, to: string): Mail {
  const x = TEXT[lang];
  const fill = (s: string) => s.replaceAll('{code}', code).replaceAll('{min}', String(CODE_MINUTES));
  return { fromName: x.app, from, to, subject: fill(x.subject), text: `${fill(x.body)}\n\n${x.app} · ${x.host}\n` };
}

// --- Message -------------------------------------------------------------------------------

function b64(s: string): string {
  let bin = '';
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}

// A header value: as it is when plain ASCII, else RFC 2047 encoded words of at
// most 75 characters (45 bytes of UTF-8 each, never splitting a character).
export function headerText(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const words: string[] = [];
  let cur = '';
  const bytes = (x: string) => new TextEncoder().encode(x).length;
  for (const ch of s) {
    if (cur && bytes(cur + ch) > 45) {
      words.push(cur);
      cur = '';
    }
    cur += ch;
  }
  if (cur) words.push(cur);
  return words.map((w) => `=?UTF-8?B?${b64(w)}?=`).join('\r\n ');
}

// What can go in <...> on the envelope and in To: no spaces, brackets or quotes.
export const MAILABLE_RE = /^[^\s@<>"()]+@[^\s@<>"()]+\.[^\s@<>"()]+$/;

export function message(m: Mail, now = new Date(), id: string = crypto.randomUUID()): string {
  const name = /^[A-Za-z0-9 ]*$/.test(m.fromName) ? `"${m.fromName}"` : headerText(m.fromName);
  const body = b64(m.text.replace(/\r?\n/g, '\r\n')).replace(/.{1,76}/g, '$&\r\n');
  return [
    `From: ${name} <${m.from}>`,
    `To: <${m.to}>`,
    `Subject: ${headerText(m.subject)}`,
    `Date: ${now.toUTCString().replace(/GMT$/, '+0000')}`,
    `Message-ID: <${id}@${m.from.split('@')[1]}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-generated',
    '',
    body,
  ].join('\r\n');
}

// --- SMTP ------------------------------------------------------------------------------

// What went wrong, for the log: the step and the server's reply, with anything
// shaped like an address taken out.
export class SmtpError extends Error {
  step: string;
  code: number;

  constructor(step: string, code: number, text: string) {
    super(`smtp ${step}: ${code} ${text.replace(/\S+@\S+/g, '<address>').slice(0, 200)}`);
    this.step = step;
    this.code = code;
  }
}

// SMTP replies off a byte stream. Lines end in CRLF (a bare LF is taken too);
// "250-..." goes on, "250 ..." (or just "250") ends the reply.
export class Replies {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #dec = new TextDecoder();
  #buf = '';

  constructor(readable: ReadableStream<Uint8Array>) {
    this.#reader = readable.getReader();
  }

  async next(): Promise<{ code: number; text: string }> {
    const lines: string[] = [];
    for (;;) {
      const i = this.#buf.indexOf('\n');
      if (i < 0) {
        const { value, done } = await this.#reader.read();
        if (done) throw new SmtpError('read', 0, 'connection closed');
        this.#buf += this.#dec.decode(value, { stream: true });
        if (this.#buf.length > 64 * 1024) throw new SmtpError('read', 0, 'reply too long');
        continue;
      }
      const line = this.#buf.slice(0, i).replace(/\r$/, '');
      this.#buf = this.#buf.slice(i + 1);
      const m = /^(\d{3})([ -]?)(.*)$/.exec(line);
      if (!m) throw new SmtpError('read', 0, `not a reply: ${line.slice(0, 40)}`);
      lines.push(m[3]);
      if (m[2] !== '-') return { code: Number(m[1]), text: lines.join(' ') };
    }
  }

  cancel(): void {
    this.#reader.cancel().catch(() => {});
  }
}

export async function sendMail(io: Duplex, auth: { user: string; pass: string }, mail: Mail, helo = 'apphub.casa'): Promise<void> {
  if (!MAILABLE_RE.test(mail.to) || !MAILABLE_RE.test(mail.from)) throw new SmtpError('address', 0, 'not mailable');
  const replies = new Replies(io.readable);
  const writer = io.writable.getWriter();
  const enc = new TextEncoder();
  const say = (s: string) => writer.write(enc.encode(`${s}\r\n`));
  const expect = async (step: string, ok: number[]) => {
    const r = await replies.next();
    if (!ok.includes(r.code)) throw new SmtpError(step, r.code, r.text);
  };
  try {
    await expect('greeting', [220]);
    await say(`EHLO ${helo}`);
    await expect('ehlo', [250]);
    await say(`AUTH PLAIN ${b64(`\0${auth.user}\0${auth.pass}`)}`);
    await expect('auth', [235]);
    await say(`MAIL FROM:<${mail.from}>`);
    await expect('mail', [250]);
    await say(`RCPT TO:<${mail.to}>`);
    await expect('rcpt', [250, 251]);
    await say('DATA');
    await expect('data', [354]);
    // Base64 lines never start with a dot, so nothing needs dot-stuffing.
    await writer.write(enc.encode(`${message(mail)}\r\n.\r\n`));
    await expect('send', [250]);
    await say('QUIT');
    await replies.next().catch(() => {});
  } finally {
    writer.close().catch(() => {});
    replies.cancel();
  }
}

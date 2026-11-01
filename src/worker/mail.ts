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
  html?: string; // sent as multipart/alternative with the text
}

export interface Duplex {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

// --- Text ------------------------------------------------------------------------------

export const NB_HOST = 'finn-tid.apphub.casa';
export const EN_HOST = 'whenever.apphub.casa';

// Where the mail's link goes: the site the code was asked on (the device
// keeps the events per site), else the language's.
export function linkHost(lang: MailLang, host: string): string {
  return host === NB_HOST || host === EN_HOST ? host : lang === 'en' ? EN_HOST : NB_HOST;
}

interface Text {
  app: string;
  subject: string;
  intro: string; // before the code
  or: string; // before the link
  button: string;
  valid: string; // {min}
  ignore: string;
}
const TEXT: Record<MailLang, Text> = {
  nb: {
    app: 'Finn tid',
    subject: '{code} er koden din i Finn tid',
    intro: 'Koden for å finne avtalene dine i Finn tid er:',
    or: 'Eller hent dem med ett trykk:',
    button: 'Vis avtalene mine',
    valid: 'Koden og lenken virker i {min} minutter, og lenken bare én gang.',
    ignore: 'Har du ikke bedt om dette, kan du se bort fra denne e-posten.',
  },
  nn: {
    app: 'Finn tid',
    subject: '{code} er koden din i Finn tid',
    intro: 'Koden for å finne avtalane dine i Finn tid er:',
    or: 'Eller hent dei med eitt trykk:',
    button: 'Vis avtalane mine',
    valid: 'Koden og lenkja verkar i {min} minutt, og lenkja berre éin gong.',
    ignore: 'Har du ikkje bede om dette, kan du sjå bort frå denne e-posten.',
  },
  sv: {
    app: 'Hitta tid',
    subject: '{code} är din kod för Hitta tid',
    intro: 'Koden för att hitta dina träffar i Hitta tid är:',
    or: 'Eller hämta dem med ett tryck:',
    button: 'Visa mina träffar',
    valid: 'Koden och länken gäller i {min} minuter, och länken bara en gång.',
    ignore: 'Om du inte har bett om det kan du bortse från det här mejlet.',
  },
  da: {
    app: 'Find tid',
    subject: '{code} er din kode til Find tid',
    intro: 'Koden til at finde dine aftaler i Find tid er:',
    or: 'Eller hent dem med ét tryk:',
    button: 'Vis mine aftaler',
    valid: 'Koden og linket gælder i {min} minutter, og linket kun én gang.',
    ignore: 'Har du ikke bedt om det, kan du se bort fra denne e-mail.',
  },
  is: {
    app: 'Finna tíma',
    subject: '{code} er kóðinn þinn fyrir Finna tíma',
    intro: 'Kóðinn til að finna viðburðina þína í Finna tíma er:',
    or: 'Eða sæktu þá með einum smelli:',
    button: 'Sýna viðburðina mína',
    valid: 'Kóðinn og hlekkurinn gilda í {min} mínútur og hlekkurinn aðeins einu sinni.',
    ignore: 'Ef þú baðst ekki um þetta geturðu hunsað þennan tölvupóst.',
  },
  en: {
    app: 'Whenever',
    subject: '{code} is your Whenever code',
    intro: 'Your code for finding your events in Whenever is:',
    or: 'Or get them with one tap:',
    button: 'Show my events',
    valid: 'The code and the link work for {min} minutes, and the link only once.',
    ignore: 'If you didn’t ask for this, you can ignore this email.',
  },
};

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c]);

// The code and a one-tap link (`link`: https://<host>/find#t=<token>); no
// event names. The HTML has inline styles only and no remote images, with the
// code big and unspaced, so copying it gives just the digits.
export function codeMail(lang: MailLang, code: string, link: string, from: string, to: string): Mail {
  const x = TEXT[lang];
  const host = new URL(link).host;
  const valid = x.valid.replace('{min}', String(CODE_MINUTES));
  const text = `${x.intro}\n\n${code}\n\n${x.or}\n${link}\n\n${valid} ${x.ignore}\n\n${x.app} · ${host}\n`;
  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const p = (html: string, style = '') => `<tr><td style="padding:0 28px 16px;font-size:16px;line-height:1.5;${style}">${html}</td></tr>`;
  const html = `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(x.app)}</title></head>
<body style="margin:0;padding:0;background:#f3f6f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f6f5;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background:#ffffff;border-radius:16px;font-family:${font};color:#172026;">
<tr><td style="padding:28px 28px 16px;font-size:20px;font-weight:700;color:#0f766e;">${esc(x.app)}</td></tr>
${p(esc(x.intro))}
${p(`<div style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:34px;font-weight:700;letter-spacing:8px;text-align:center;background:#eef3f2;border-radius:12px;padding:16px 8px;">${esc(code)}</div>`)}
${p(esc(x.or))}
<tr><td align="center" style="padding:0 28px 24px;"><a href="${esc(link)}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:12px 28px;border-radius:999px;">${esc(x.button)}</a></td></tr>
${p(`${esc(valid)} ${esc(x.ignore)}`, 'font-size:14px;color:#5b6970;')}
<tr><td style="padding:16px 28px 24px;border-top:1px solid #dde4e2;font-size:13px;color:#5b6970;">${esc(x.app)} · ${esc(host)}</td></tr>
</table></td></tr></table>
</body></html>
`;
  return { fromName: x.app, from, to, subject: x.subject.replaceAll('{code}', code), text, html };
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

// A body part: base64 in lines of 76 (which never start with a dot or "--").
const part = (s: string) => b64(s.replace(/\r?\n/g, '\r\n')).replace(/.{1,76}/g, '$&\r\n');

export function message(m: Mail, now = new Date(), id: string = crypto.randomUUID()): string {
  const name = /^[A-Za-z0-9 ]*$/.test(m.fromName) ? `"${m.fromName}"` : headerText(m.fromName);
  const head = [
    `From: ${name} <${m.from}>`,
    `To: <${m.to}>`,
    `Subject: ${headerText(m.subject)}`,
    `Date: ${now.toUTCString().replace(/GMT$/, '+0000')}`,
    `Message-ID: <${id}@${m.from.split('@')[1]}>`,
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-generated',
  ];
  const plain = ['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64'];
  if (!m.html) return [...head, ...plain, '', part(m.text)].join('\r\n');
  // Base64 has no "=_", so the boundary can't turn up in a part.
  const b = `=_whenever_${id}`;
  return [
    ...head,
    `Content-Type: multipart/alternative; boundary="${b}"`,
    '',
    `--${b}`,
    ...plain,
    '',
    part(m.text),
    `--${b}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    part(m.html),
    `--${b}--`,
    '',
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

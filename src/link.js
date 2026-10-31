// Admin and personal links. A link is /e/<eventId>/<token>, and the token is
// two fixed-length parts, back to back (38 characters):
//
//   selector  16 hex: a participant id, or the event's admin id
//   secret    22 base64url: 16 random bytes stored with that row
//
// The selector finds the row (it isn't secret); the secret is compared in
// constant time. Resetting a link stores a new secret, so the old link stops
// working; deleting the participant or the event kills their links too.
// Secrets are stored as they are, not hashed, so the admin can copy a
// participant's current link again: whoever can read an event's storage can
// change the event anyway. There is no key or secret outside the event.

import { PID_RE, TOKEN_RE } from '../public/model.js';

export { PID_RE, TOKEN_RE };

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const newPid = () => hex(crypto.getRandomValues(new Uint8Array(8)));
export const newSecret = () => b64url(crypto.getRandomValues(new Uint8Array(16)));
export const token = (sel, secret) => sel + secret;

// token -> { sel, secret } or null when it isn't shaped like one.
export function parse(t) {
  if (typeof t !== 'string' || !TOKEN_RE.test(t)) return null;
  return { sel: t.slice(0, 16), secret: t.slice(16) };
}

// Constant-time string comparison (for equal lengths; lengths aren't secret).
export function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

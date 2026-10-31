// Personal links without a token table. A link is /e/<eventId>/<token>, where
// the token is AES-256-GCM over a tiny record:
//
//   role (1 byte: 1 admin, 2 participant) | generation (uint32) | participant id (8 bytes)
//
// The key is derived per event with HKDF-SHA256 from the LINK_SECRET Worker
// secret (info = event id), and the event id is also the additional
// authenticated data, so a token only opens on its own event. The wire format
// is base64url(version | iv | ciphertext+tag): 56 characters.
//
// Revocation needs no stored tokens either: the event keeps a generation
// counter per participant (and one for the admin). Resetting a link bumps it,
// so older tokens decrypt fine but no longer match. Deleting the participant
// or the event kills their links too.

const VERSION = 1;
const ROLE_CODE = { admin: 1, participant: 2 };
const ROLE_NAME = { 1: 'admin', 2: 'participant' };
const PLAIN = 13;
const IV = 12;
const TAG = 16;
export const TOKEN_RE = /^[A-Za-z0-9_-]{56}$/;
export const PID_RE = /^[0-9a-f]{16}$/;
const MIN_SECRET = 32;

const enc = new TextEncoder();
const SALT = enc.encode('whenever link v1');

export const usableSecret = (secret) => typeof secret === 'string' && secret.length >= MIN_SECRET;

let cached = { secret: null, key: null };
async function baseKey(secret) {
  if (cached.secret !== secret) {
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
    cached = { secret, key };
  }
  return cached.key;
}

async function eventKey(secret, eventId) {
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: SALT, info: enc.encode(eventId) },
    await baseKey(secret),
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

const aad = (eventId) => enc.encode(`${VERSION}:${eventId}`);

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => Uint8Array.from(s.match(/../g), (h) => parseInt(h, 16));

export const newPid = () => hex(crypto.getRandomValues(new Uint8Array(8)));

// { role: 'admin' | 'participant', gen, pid? } -> token
export async function seal(secret, eventId, { role, gen, pid }) {
  if (!usableSecret(secret)) throw new Error('LINK_SECRET missing or too short');
  const plain = new Uint8Array(PLAIN);
  plain[0] = ROLE_CODE[role];
  new DataView(plain.buffer).setUint32(1, gen >>> 0);
  if (role === 'participant') plain.set(unhex(pid), 5);
  const iv = crypto.getRandomValues(new Uint8Array(IV));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(eventId) }, await eventKey(secret, eventId), plain));
  const out = new Uint8Array(1 + IV + ct.length);
  out[0] = VERSION;
  out.set(iv, 1);
  out.set(ct, 1 + IV);
  return b64url(out);
}

// token -> { role, gen, pid } or null (wrong event, tampered, wrong key, junk).
export async function open(secret, eventId, token) {
  if (!usableSecret(secret) || typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  try {
    const raw = unb64url(token);
    if (raw.length !== 1 + IV + PLAIN + TAG || raw[0] !== VERSION) return null;
    const plain = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(1, 1 + IV), additionalData: aad(eventId) }, await eventKey(secret, eventId), raw.subarray(1 + IV)),
    );
    const role = ROLE_NAME[plain[0]];
    if (!role) return null;
    const gen = new DataView(plain.buffer).getUint32(1);
    return role === 'admin' ? { role, gen } : { role, gen, pid: hex(plain.subarray(5)) };
  } catch {
    return null;
  }
}

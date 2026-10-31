// This device's memory, in localStorage (key whenever-v1): links to events you
// made or answered, so you find them again, plus the language choice. Only a
// convenience: every link works on any device without it. All keys used by
// the app start with whenever-.

const KEY = 'whenever-v1';
const TOKEN_RE = /^[A-Za-z0-9_-]{56}$/;

function read() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {};
  }
}

function write(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Private mode or full storage: links still work, they just aren't remembered.
  }
}

const clean = (e) => ({
  name: typeof e.name === 'string' ? e.name : '',
  admin: TOKEN_RE.test(e.admin ?? '') ? e.admin : undefined,
  me: TOKEN_RE.test(e.me ?? '') ? e.me : undefined,
  pid: /^[0-9a-f]{16}$/.test(e.pid ?? '') ? e.pid : undefined,
  seen: Number(e.seen) || 0,
});

export function events() {
  return Object.entries(read().events ?? {})
    .filter(([id]) => /^[A-Za-z0-9]{12}$/.test(id))
    .map(([id, e]) => ({ id, ...clean(e ?? {}) }))
    .sort((a, b) => b.seen - a.seen);
}

export function get(id) {
  const e = read().events?.[id];
  return e ? clean(e) : null;
}

export function put(id, patch) {
  const s = read();
  s.events ??= {};
  s.events[id] = { ...(s.events[id] ?? {}), ...patch, seen: Date.now() };
  write(s);
}

// A link that no longer works: forget it (and the event if nothing is left).
export function dropToken(id, token) {
  const s = read();
  const e = s.events?.[id];
  if (!e) return;
  if (e.admin === token) delete e.admin;
  if (e.me === token) {
    delete e.me;
    delete e.pid;
  }
  if (!e.admin && !e.me) delete s.events[id];
  write(s);
}

export function forgetMe(id) {
  const s = read();
  const e = s.events?.[id];
  if (!e) return;
  delete e.me;
  delete e.pid;
  if (!e.admin) delete s.events[id];
  write(s);
}

export function forget(id) {
  const s = read();
  if (s.events) delete s.events[id];
  write(s);
}

export function getLang() {
  const l = read().lang;
  return l === 'nb' || l === 'en' ? l : null;
}

export function setLang(lang) {
  const s = read();
  s.lang = lang;
  write(s);
}

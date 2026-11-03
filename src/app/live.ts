// Live updates for the open event page: a WebSocket to the event's Poll
// object (src/worker/poll.ts), which sends this page's view after every
// change. The link goes in the first message, never in the URL. It
// reconnects by itself (after 1, 2, 5, 10, then every 30 s; after five
// failed tries without ever opening it stops, and the app's own 30 s refresh
// carries on), says hello again when the page is shown again (a fresh view
// and the live app version), and pings every 30 s so nothing in between
// drops it for being idle. <html data-live="open|closed"> shows the state
// (the smoke test waits for it).

import type { LiveMessage } from '../shared/model.ts';

const BACKOFF = [1000, 2000, 5000, 10000, 30000];
const PING = 30000;

type Handler = (m: LiveMessage, key: string) => void;

let key: string | null = null; // `${id}/${token}` being followed
let token: string | null = null;
let handler: Handler = () => {};
let ws: WebSocket | null = null;
let up = false;
let opened = false; // this key's socket has opened at least once
let tries = 0;
let retry: ReturnType<typeof setTimeout> | undefined;
let ping: ReturnType<typeof setInterval> | undefined;

const state = (s: 'open' | 'closed') => {
  document.documentElement.dataset.live = s;
};

export const isOpen = (): boolean => up;
export const following = (): string | null => key;

// Follow an event (id and the page's link, or none), or nothing (id null).
// Calling it again with the same event and link changes nothing.
export function follow(id: string | null, tok: string | null = null, onMessage: Handler = () => {}): void {
  const k = id ? `${id}/${tok ?? ''}` : null;
  handler = onMessage;
  if (k === key) return;
  stop();
  key = k;
  token = tok;
  opened = false;
  tries = 0;
  if (id) open(id);
}

function open(id: string): void {
  const k = key;
  let sock: WebSocket;
  try {
    sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/events/${id}/live`);
  } catch {
    return state('closed'); // Not allowed here: the 30 s refresh it is.
  }
  ws = sock;
  sock.onopen = () => {
    if (ws !== sock) return;
    up = true;
    opened = true;
    tries = 0;
    state('open');
    hello();
    ping = setInterval(() => sock.readyState === WebSocket.OPEN && sock.send('ping'), PING);
  };
  sock.onmessage = (e) => {
    if (ws !== sock || typeof e.data !== 'string' || e.data === 'pong' || !k) return;
    let m: LiveMessage;
    try {
      m = JSON.parse(e.data) as LiveMessage;
    } catch {
      return;
    }
    handler(m, k);
  };
  sock.onclose = (e) => {
    if (ws !== sock) return;
    ws = null;
    up = false;
    clearInterval(ping);
    state('closed');
    // The event is gone (the message said so), or the server is out of reach.
    if (e.reason === 'gone' || (!opened && tries >= BACKOFF.length)) return;
    retry = setTimeout(() => key === k && open(id), BACKOFF[Math.min(tries++, BACKOFF.length - 1)]);
  };
}

// Ask for a fresh view now (the server allows one every 2 s).
export function hello(): void {
  if (ws && up) ws.send(JSON.stringify({ token }));
}

// The page is shown again: a fresh view if open, else try again at once.
export function wake(): void {
  if (up) return hello();
  if (!key || ws) return;
  clearTimeout(retry);
  tries = 0;
  open(key.slice(0, key.indexOf('/')));
}

function stop(): void {
  clearTimeout(retry);
  clearInterval(ping);
  const s = ws;
  ws = null;
  up = false;
  key = null;
  state('closed');
  if (s && s.readyState <= WebSocket.OPEN) s.close(1000);
}

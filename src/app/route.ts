// Routing: the page's address as a route, event addresses, and moving
// between pages.
//
// Routes (path): /  ·  /new  ·  /find  ·  /e/<id>
// An admin or personal link has its token in the hash, /e/<id>#<token>, so
// the browser never sends it with the page (the app sends it to the API as
// the Bearer header). Sub-views of an event follow it after an &:
// #<token>&edit, #<token>&answer=<pid>; on the event link just #edit,
// #answer, #answer=<pid>. Links from before, /e/<id>/<token>, still open:
// the app moves the token into the hash at once (moveToken).

import * as M from '../shared/model.ts';
import { type Route, type Sub, app } from './state.ts';
import { render } from './render.ts';

const ROUTE_RE = new RegExp(`^/e/([A-Za-z0-9]{12})(?:/(${M.TOKEN}))?$`);
const ANSWER_RE = new RegExp(`^answer=(${M.PID})$`);
// The token at the start of the hash, and the & after it.
const HASH_TOKEN_RE = new RegExp(`^(${M.TOKEN})(?:&|$)`);

// An event page's address: the token (if any) and then the sub-view ('' =
// the overview) in the hash.
export function eventPath(id: string, token: string | null, sub = ''): string {
  const h = [token, sub].filter(Boolean).join('&');
  return `/e/${id}${h ? `#${h}` : ''}`;
}

// A link from before, /e/<id>/<token>: the same page with the token in the
// hash, in place of this history entry. Remove (with the token group in
// ROUTE_RE) once the events from before are gone: see CLAUDE.md, Links.
export function moveToken(): void {
  const m = location.pathname.replace(/\/+$/, '').match(ROUTE_RE);
  if (m?.[2]) history.replaceState(history.state, '', eventPath(m[1], m[2], location.hash.slice(1).replace(HASH_TOKEN_RE, '')));
}

export function parseRoute(): Route {
  const p = location.pathname.replace(/\/+$/, '') || '/';
  if (p === '/') return { page: 'home' };
  if (p === '/new') return { page: 'new' };
  if (p === '/find') return { page: 'find' };
  const m = p.match(ROUTE_RE);
  if (m) return { page: 'event', id: m[1], token: m[2] ?? HASH_TOKEN_RE.exec(location.hash.slice(1))?.[1] ?? null };
  return { page: 'missing' };
}

// The hash without the token: which sub-view of the event is open.
function subHash(): string {
  return location.hash.slice(1).replace(HASH_TOKEN_RE, '');
}

// This event page's address with another sub-view ('' = the overview),
// keeping the token.
export function subUrl(sub: string): string {
  const r = app.route;
  return r?.page === 'event' ? eventPath(r.id, r.token, sub) : `${location.pathname}${sub ? `#${sub}` : ''}`;
}

export function subView(): Sub {
  const h = subHash();
  if (h === 'edit') return { kind: 'edit' };
  if (h === 'answer') return { kind: 'answer', pid: null };
  // From before: the admin's "for someone else", now the same as #answer.
  if (h === 'answer=new') return { kind: 'answer', pid: 'new' };
  const m = h.match(ANSWER_RE);
  if (m) return { kind: 'answer', pid: m[1] };
  return { kind: 'overview' };
}

export function go(url: string, replace = false): void {
  history[replace ? 'replaceState' : 'pushState'](null, '', url);
  app.pushedSub = false;
  render();
}

export function openSub(hash: string): void {
  history.pushState(null, '', subUrl(hash));
  app.pushedSub = true;
  render();
}

export function closeSub(): void {
  if (app.pushedSub) {
    app.pushedSub = false;
    history.back();
  } else {
    history.replaceState(null, '', subUrl(''));
    render();
  }
}

export const eventUrl = (id: string) => `${location.origin}/e/${id}`;
export const linkUrl = (id: string, token: string | null) => `${location.origin}${eventPath(id, token)}`;

// Undo and redo for the event form's day and time picker. Pure (no DOM), so
// the tests can drive it.
//
// `base` is the state as of the last step. After every change the form calls
// commit() with the new state: if it differs, the old base becomes an undo
// step. Snapshots are sorted copies, never the draft's live Sets, so later
// edits can't reach into the history.

export interface Snap {
  dates: string[];
  times: string[];
  pattern: number[] | null;
}

export const HISTORY_MAX = 50;

export function sameSnap(a: Snap, b: Snap): boolean {
  const eq = <T>(x: readonly T[], y: readonly T[]) => x.length === y.length && x.every((v, i) => v === y[i]);
  return eq(a.dates, b.dates) && eq(a.times, b.times) && (a.pattern === null || b.pattern === null ? a.pattern === b.pattern : eq(a.pattern, b.pattern));
}

export class History {
  base: Snap;
  undo: Snap[] = [];
  redo: Snap[] = [];

  constructor(s: Snap) {
    this.base = s;
  }

  // Start over from s (a new draft, or a change the steps can't go back past).
  reset(s: Snap): void {
    this.base = s;
    this.undo = [];
    this.redo = [];
  }

  // The state is now s. True when that made a step; a new step drops redo.
  commit(s: Snap): boolean {
    if (sameSnap(s, this.base)) return false;
    this.undo.push(this.base);
    if (this.undo.length > HISTORY_MAX) this.undo.shift();
    this.redo = [];
    this.base = s;
    return true;
  }

  // The state to go back to from cur, or null. A change that wasn't
  // committed yet becomes a step first, so it isn't lost.
  back(cur: Snap): Snap | null {
    this.commit(cur);
    const s = this.undo.pop();
    if (!s) return null;
    this.redo.push(this.base);
    this.base = s;
    return s;
  }

  forward(cur: Snap): Snap | null {
    this.commit(cur);
    const s = this.redo.pop();
    if (!s) return null;
    this.undo.push(this.base);
    this.base = s;
    return s;
  }
}

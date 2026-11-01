import { test } from 'node:test';
import assert from 'node:assert/strict';
import { History, HISTORY_MAX, sameSnap } from '../src/app/history.ts';
import type { Snap } from '../src/app/history.ts';

const s = (dates: string[], times: string[] = [], pattern: number[] | null = null): Snap => ({ dates, times, pattern });
const A = s([]);
const B = s(['2026-11-02']);
const C = s(['2026-11-02', '2026-11-03']);

test('a change is a step; no change is none', () => {
  const h = new History(A);
  assert.equal(h.commit(s([])), false);
  assert.equal(h.undo.length, 0);
  assert.equal(h.commit(B), true);
  assert.deepEqual(h.undo, [A]);
});

test('undo and redo walk the steps both ways', () => {
  const h = new History(A);
  h.commit(B);
  h.commit(C);
  assert.deepEqual(h.back(C), B);
  assert.deepEqual(h.back(B), A);
  assert.equal(h.back(A), null);
  assert.deepEqual(h.forward(A), B);
  assert.deepEqual(h.forward(B), C);
  assert.equal(h.forward(C), null);
});

test('a new change after undo drops redo', () => {
  const h = new History(A);
  h.commit(B);
  h.back(B);
  assert.equal(h.redo.length, 1);
  h.commit(C);
  assert.equal(h.redo.length, 0);
  assert.equal(h.forward(C), null);
});

test('undo first keeps a change that was never committed', () => {
  const h = new History(A);
  h.commit(B);
  // C was reached without a commit: undo goes back to B, and redo gives C.
  assert.deepEqual(h.back(C), B);
  assert.deepEqual(h.forward(B), C);
});

test('the pattern counts, and null differs from empty', () => {
  assert.equal(sameSnap(s([], [], null), s([], [], [])), false);
  assert.equal(sameSnap(s([], [], [540]), s([], [], [540])), true);
  assert.equal(sameSnap(s([], ['2026-11-02T09:00']), s([], [])), false);
});

test('at most HISTORY_MAX steps are kept', () => {
  const h = new History(s(['0']));
  for (let i = 1; i <= HISTORY_MAX + 10; i++) h.commit(s([String(i)]));
  assert.equal(h.undo.length, HISTORY_MAX);
  assert.deepEqual(h.undo[0], s(['10']));
});

test('reset forgets every step', () => {
  const h = new History(A);
  h.commit(B);
  h.back(B);
  h.reset(C);
  assert.equal(h.undo.length + h.redo.length, 0);
  assert.equal(h.back(C), null);
});

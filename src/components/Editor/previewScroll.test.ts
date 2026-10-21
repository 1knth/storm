import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
const expect = (actual: unknown) => ({
  toBe(expected: unknown) {
    assert.equal(actual, expected);
  },
  toBeNull() {
    assert.equal(actual, null);
  },
});
import { EditorState, Transaction } from '@codemirror/state';
import {
  isUserSelectionChange,
  previewScrollTopForCursor,
  smoothScrollTo,
  previewTopAtSourceLine,
  type PreviewAnchor,
} from './previewScroll';

describe('smooth programmatic scrolling', () => {
  it('records the actual intermediate position and can cancel a retargeted animation', () => {
    const originalWindow = globalThis.window;
    let callback: FrameRequestCallback | undefined;
    let nextFrame = 1;
    const frames = new Map<number, FrameRequestCallback>();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        matchMedia: () => ({ matches: false }),
        requestAnimationFrame: (fn: FrameRequestCallback) => {
          const id = nextFrame++;
          const wrapped: FrameRequestCallback = (time) => {
            frames.delete(id);
            fn(time);
          };
          frames.set(id, wrapped);
          callback = wrapped;
          return id;
        },
        cancelAnimationFrame: (id: number) => frames.delete(id),
      },
    });
    const element = {
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 100,
    } as HTMLElement;
    const applied: number[] = [];
    const controller = { active: false, cancel: () => {} };
    try {
      smoothScrollTo(element, 500, controller, 100, (top) => applied.push(top));
      callback?.(0);
      callback?.(50);
      assert.equal(element.scrollTop, 437.5);
      assert.deepEqual(applied, [0, 437.5]);
      const pending = [...frames.keys()][0];
      smoothScrollTo(element, 100, controller, 100, (top) => applied.push(top));
      assert.equal(frames.has(pending), false);
      controller.cancel();
      assert.equal(controller.active, false);
    } finally {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: originalWindow,
      });
    }
  });

  it('applies reduced-motion targets instantly', () => {
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { matchMedia: () => ({ matches: true }) },
    });
    const element = {
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 100,
    } as HTMLElement;
    const controller = { active: false, cancel: () => {} };
    try {
      smoothScrollTo(element, 400, controller, 100, (top) =>
        assert.equal(top, 400),
      );
      assert.equal(element.scrollTop, 400);
      assert.equal(controller.active, false);
    } finally {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: originalWindow,
      });
    }
  });
});

describe('selection-driven preview following', () => {
  const state = EditorState.create({ doc: 'first\\nsecond\\nthird' });

  it('recognizes pointer, keyboard, and text-input selection transactions', () => {
    const pointer = state.update({
      selection: { anchor: 2 },
      userEvent: 'select.pointer',
    });
    const keyboard = state.update({
      selection: { anchor: 8 },
      userEvent: 'move.character',
    });
    const vimLineMove = state.update({
      selection: { anchor: 12 },
      userEvent: 'move.line',
    });
    const input = state.update({
      selection: { anchor: 5 },
      userEvent: 'input.type',
    });
    for (const transaction of [pointer, keyboard, vimLineMove, input])
      assert.equal(isUserSelectionChange(true, [transaction]), true);
  });

  it('ignores programmatic restores, unannotated transactions, document-only changes, and viewport scrolling', () => {
    const restore = state.update({ selection: { anchor: 8 } });
    const managedRestore = state.update({
      selection: { anchor: 8 },
      annotations: Transaction.addToHistory.of(false),
    });
    const documentChange = state.update({ changes: { from: 0, insert: 'x' } });
    assert.equal(isUserSelectionChange(true, [restore]), false);
    assert.equal(isUserSelectionChange(true, [managedRestore]), false);
    assert.equal(
      isUserSelectionChange(false, [
        state.update({ userEvent: 'select.pointer' }),
      ]),
      false,
    );
    assert.equal(isUserSelectionChange(false, [documentChange]), false);
  });
});

describe('preview source-line scrolling', () => {
  it('maps lines proportionally within blocks with different rendered heights', () => {
    const anchors: PreviewAnchor[] = [
      { start: 1, end: 3, top: 0, height: 90 },
      { start: 4, end: 5, top: 90, height: 240 },
    ];
    expect(previewTopAtSourceLine(2, anchors)).toBe(30);
    expect(previewTopAtSourceLine(5, anchors)).toBe(210);
  });

  it('maps source positions inside a fenced-code/Mermaid-sized block', () => {
    const anchors = [{ start: 10, end: 16, top: 300, height: 700 }];
    expect(previewTopAtSourceLine(10, anchors)).toBe(300);
    expect(previewTopAtSourceLine(16, anchors)).toBe(900);
  });

  it('clamps source positions to the first or last available block', () => {
    const anchors = [
      { start: 4, end: 5, top: 40, height: 20 },
      { start: 10, end: 11, top: 200, height: 80 },
    ];
    expect(previewTopAtSourceLine(1, anchors)).toBe(40);
    expect(previewTopAtSourceLine(99, anchors)).toBe(280);
  });

  it('ignores invalid anchors and safely handles duplicate/zero-length spans', () => {
    const anchors = [
      { start: Number.NaN, end: 3, top: 0, height: 10 },
      { start: 7, end: 7, top: 50, height: 12 },
      { start: 7, end: 7, top: 50, height: 12 },
    ];
    expect(previewTopAtSourceLine(7, anchors)).toBe(50);
    expect(previewTopAtSourceLine(8, anchors)).toBe(62);
    expect(previewTopAtSourceLine(1, [])).toBeNull();
  });

  it('keeps an already-visible cursor still and minimally reveals above/below', () => {
    expect(previewScrollTopForCursor(150, 100, 200, 1000)).toBeNull();
    expect(previewScrollTopForCursor(110, 100, 200, 1000)).toBe(70);
    expect(previewScrollTopForCursor(290, 100, 200, 1000)).toBe(250);
  });

  it('clamps cursor reveal at preview scroll boundaries', () => {
    expect(previewScrollTopForCursor(10, 0, 200, 1000)).toBe(0);
    expect(previewScrollTopForCursor(990, 800, 200, 1000)).toBe(800);
  });
});

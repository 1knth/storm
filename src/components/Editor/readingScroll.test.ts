import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scrollReadingPreview } from './readingScroll';

function event(key: string, overrides: Record<string, unknown> = {}) {
  let prevented = false;
  let stopped = false;
  return {
    value: {
      key,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      target: null,
      preventDefault: () => {
        prevented = true;
      },
      stopPropagation: () => {
        stopped = true;
      },
      ...overrides,
    },
    consumed: () => prevented && stopped,
  };
}

describe('reading preview j/k scrolling', () => {
  it('scrolls the preview by a bounded 40px step and consumes the key', () => {
    const pane = { scrollTop: 20, scrollHeight: 300, clientHeight: 100 };
    const down = event('j');
    assert.equal(
      scrollReadingPreview(down.value as KeyboardEvent, pane, false),
      true,
    );
    assert.equal(pane.scrollTop, 60);
    assert.equal(down.consumed(), true);
    const up = event('k');
    assert.equal(
      scrollReadingPreview(up.value as KeyboardEvent, pane, false),
      true,
    );
    assert.equal(pane.scrollTop, 20);
  });

  it('does not consume keys in blocked contexts or at scroll boundaries', () => {
    const pane = { scrollTop: 0, scrollHeight: 100, clientHeight: 100 };
    for (const [key, overrides, modal] of [
      ['j', {}, true],
      ['J', {}, false],
      ['j', { ctrlKey: true }, false],
      ['k', { target: { closest: () => true } }, false],
      ['k', {}, false],
    ] as const) {
      const input = event(key, overrides);
      assert.equal(
        scrollReadingPreview(input.value as KeyboardEvent, pane, modal),
        false,
      );
      assert.equal(input.consumed(), false);
    }
  });
});

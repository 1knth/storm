import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isActiveAgentPreviewReveal,
  isNextPreviewVisualLine,
  previewFollowTailSpace,
  previewFollowTarget,
} from './previewAutoFollow';

describe('agent preview auto-follow', () => {
  it('places a newly revealed visual line at 75% of the viewport', () => {
    assert.equal(
      previewFollowTarget({
        visualLineTop: 1200,
        clientHeight: 800,
        scrollHeight: 3000,
      }),
      600,
    );
  });

  it('clamps short documents and targets to the available scroll range', () => {
    assert.equal(
      previewFollowTarget({
        visualLineTop: 120,
        clientHeight: 800,
        scrollHeight: 500,
      }),
      0,
    );
    assert.equal(
      previewFollowTarget({
        visualLineTop: 3000,
        clientHeight: 800,
        scrollHeight: 1400,
      }),
      600,
    );
  });

  it('provides a quarter-viewport tail so an end line can reach 75%', () => {
    const viewport = 800;
    const tail = previewFollowTailSpace(viewport);
    const scrollHeight = 5774;
    const clientHeight = viewport;
    const finalLineTop = 5773.91;
    const maxScrollWithTail = scrollHeight + tail - clientHeight;
    const target = previewFollowTarget({
      visualLineTop: finalLineTop,
      clientHeight,
      scrollHeight: scrollHeight + tail,
    });

    assert.equal(tail, 200);
    assert.ok(finalLineTop - target >= viewport * 0.75 - 1);
    assert.equal(target, finalLineTop - viewport * 0.75);
    assert.ok(target < maxScrollWithTail);
  });

  it('coalesces words on the same visual line but advances on the next line', () => {
    assert.equal(isNextPreviewVisualLine(100, 100), false);
    assert.equal(isNextPreviewVisualLine(101, 100), false);
    assert.equal(isNextPreviewVisualLine(103, 100), true);
  });

  it('is active only for an identified reveal with source ranges', () => {
    assert.equal(
      isActiveAgentPreviewReveal(undefined, [{ from: 1, to: 2 }]),
      false,
    );
    assert.equal(isActiveAgentPreviewReveal('session', []), false);
    assert.equal(
      isActiveAgentPreviewReveal('session', [{ from: 1, to: 2 }]),
      true,
    );
  });
});

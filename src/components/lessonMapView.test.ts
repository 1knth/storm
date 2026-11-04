import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  centerOn,
  clampScale,
  fitView,
  initialView,
  MAX_SCALE,
  MIN_SCALE,
  READABLE_SCALE,
  zoomAt,
} from './lessonMapView';

const viewport = { width: 424, height: 200 };

test('fit never enlarges and centres a small map', () => {
  const view = fitView({ width: 200, height: 100 }, viewport);
  assert.equal(view.scale, 1);
  assert.equal(view.x, 112);
  assert.equal(view.y, 50);
});

test('fit shrinks a wide map to the viewport', () => {
  const view = fitView({ width: 800, height: 100 }, viewport);
  assert.equal(view.scale, 0.5);
  assert.equal(view.x, 12);
});

test('large maps open at a readable scale centred on the focused topic', () => {
  const focus = { x: 1400, y: 300, width: 100, height: 40 };
  const view = initialView({ width: 2000, height: 600 }, viewport, focus);
  assert.equal(view.scale, READABLE_SCALE);
  // Focus centre (1450, 320) lands at the viewport centre (212, 100).
  assert.ok(Math.abs(view.x + 1450 * view.scale - 212) < 1e-9);
  assert.ok(Math.abs(view.y + 320 * view.scale - 100) < 1e-9);
  // Without focus it starts at the top-left, still readable.
  assert.deepEqual(
    initialView({ width: 2000, height: 600 }, viewport, undefined),
    {
      x: 12,
      y: 12,
      scale: READABLE_SCALE,
    },
  );
});

test('readable-enough maps are fitted whole even with a focus', () => {
  const view = initialView({ width: 500, height: 150 }, viewport, {
    x: 400,
    y: 10,
    width: 50,
    height: 20,
  });
  assert.ok(view.scale >= READABLE_SCALE && view.scale < 1);
});

test('zoom keeps the point under the cursor fixed and clamps scale', () => {
  const start = { x: 10, y: 20, scale: 1 };
  const zoomed = zoomAt(start, 2, 110, 70);
  // Diagram point under (110, 70) before: (100, 50); after it must map back.
  assert.equal(zoomed.x + 100 * zoomed.scale, 110);
  assert.equal(zoomed.y + 50 * zoomed.scale, 70);
  assert.equal(zoomAt(start, 100, 0, 0).scale, MAX_SCALE);
  assert.equal(zoomAt(start, 0.001, 0, 0).scale, MIN_SCALE);
  assert.equal(clampScale(1), 1);
});

test('centerOn keeps scale and centres the box', () => {
  const view = centerOn(
    { x: 0, y: 0, scale: 2 },
    { x: 10, y: 10, width: 20, height: 20 },
    viewport,
  );
  assert.deepEqual(view, { x: 172, y: 60, scale: 2 });
});

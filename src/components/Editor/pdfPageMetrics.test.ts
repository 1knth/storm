import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PdfPageMetrics } from './pdfPageMetrics';

describe('PdfPageMetrics', () => {
  it('uses measured mixed page sizes and finds exact boundaries', () => {
    const metrics = new PdfPageMetrics(3, { width: 600, height: 800 }, 1);
    assert.equal(metrics.top(3), 1648);
    metrics.setSize(2, { width: 600, height: 1200 });
    assert.equal(metrics.top(3), 2048);
    assert.equal(metrics.top(2), 824);
    assert.equal(metrics.pageAt(824), 2);
    assert.equal(metrics.pageAt(2048), 3);
    assert.equal(metrics.totalHeight(), 2848);
  });

  it('preserves the logical page and within-page offset across zoom changes', () => {
    const metrics = new PdfPageMetrics(10, { width: 612, height: 792 }, 1);
    const page = 6;
    const fraction = 0.4;
    metrics.setZoom(1.75);
    const restored = metrics.top(page) + metrics.size(page).height * fraction;

    assert.equal(metrics.pageAt(restored), page);
    assert.ok(
      Math.abs(
        restored - metrics.top(page) - metrics.size(page).height * fraction,
      ) < 1e-9,
    );
  });

  it('scales cached native measurements at zoom and bounds large windows', () => {
    const metrics = new PdfPageMetrics(2000, { width: 600, height: 800 }, 1);
    metrics.setSize(1000, { width: 600, height: 1200 });
    metrics.setZoom(2);
    assert.equal(metrics.top(1001), 1_624_800);
    assert.equal(metrics.pageAt(metrics.top(1001)), 1001);
    assert.deepEqual(metrics.window(metrics.top(1000), 1000), {
      first: 998,
      last: 1002,
    });
    assert.equal(metrics.totalHeight(), 3_248_776);
  });
});

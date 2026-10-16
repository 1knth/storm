import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { hasExternalCssReference } from './svgReferences';

test('SVG CSS reference fixtures', () => {
  const fixtures: [string, boolean][] = [
    ['url(#marker)', false],
    ["url( '#paint.server' )", false],
    ['url(https://example.test/paint.svg#id)', true],
    ['url(//example.test/paint.svg)', true],
    ["url('data:image/svg+xml,svg')", true],
    ['@import url(#theme)', true],
    ['@font-face { font-family: remote; src: url(#font) }', true],
    ['url/**/(#marker)', true],
    ['u\\72l(#marker)', true],
  ];
  for (const [css, expected] of fixtures) {
    assert.equal(hasExternalCssReference(css), expected, css);
  }
});

import React from 'react';
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AnimatedRevealWord, RevealWordAdapter } from './MarkdownPreview';

describe('preview reveal word component identity', () => {
  const elementFor = (sourceKey: string, text: string) =>
    RevealWordAdapter({
      children: text,
      'data-reveal-key': sourceKey,
      className: 'markdown-word-reveal',
    });

  it('keys the hook-owning child by source identity, not outer position', () => {
    const first = elementFor('word:10:0:0', 'first');
    const replacement = elementFor('word:30:0:0', 'second');
    const partialUpdate = elementFor('word:10:0:0', 'first!');

    assert.equal(first.type, AnimatedRevealWord);
    assert.equal(replacement.type, AnimatedRevealWord);
    assert.notEqual(first.key, replacement.key);
    assert.equal(first.key, partialUpdate.key);
    assert.equal(first.props.children, 'first');
    assert.equal(partialUpdate.props.children, 'first!');
  });

  it('keeps mount-sensitive hooks off the positional span adapter', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(
      new URL('./MarkdownPreview.tsx', import.meta.url),
      'utf8',
    );
    const adapter = source.match(
      /export function RevealWordAdapter\([\s\S]*?\n\}/,
    )?.[0];
    const animated = source.match(
      /export function AnimatedRevealWord\([\s\S]*?\n\}/,
    )?.[0];

    assert.ok(adapter);
    assert.doesNotMatch(adapter, /useRef|useState/);
    assert.match(animated ?? '', /useRef/);
    assert.match(adapter, /<AnimatedRevealWord key=\{key\}/);
  });
});

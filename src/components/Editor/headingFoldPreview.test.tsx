import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { markdownPreviewUrlTransform } from './MarkdownPreview';

import MarkdownPreview from './MarkdownPreview';
import { DEFAULT_APPEARANCE } from '../../appearance';

function preview(markdown: string, appearance = DEFAULT_APPEARANCE) {
  return renderToStaticMarkup(
    React.createElement(MarkdownPreview, {
      markdown,
      vaultId: 'test-vault',
      notePath: 'current.md',
      appearance,
      onToggleTask: () => {},
      onOpenNote: () => {},
    } as any),
  );
}

describe('preview heading section rendering', () => {
  it('sets independent emphasis colors on the rendered preview only', () => {
    const html = preview('**bold** and *italic*', {
      ...DEFAULT_APPEARANCE,
      previewBoldColor: '#123456',
      previewItalicColor: '#abcdef',
    });
    assert.match(
      html,
      /style="--preview-bold-color:#123456;--preview-italic-color:#abcdef"/,
    );
    assert.match(html, /<strong[^>]*>bold<\/strong>/);
    assert.match(html, /<em[^>]*>italic<\/em>/);

    const defaultHtml = preview('**bold** and *italic*');
    assert.doesNotMatch(defaultHtml, /--preview-(?:bold|italic)-color/);
    assert.match(defaultHtml, /<strong[^>]*>bold<\/strong>/);
    assert.match(defaultHtml, /<em[^>]*>italic<\/em>/);
  });
  it('nests sections and closes at equal or higher heading levels', () => {
    const html = preview(
      '# One\nbody\n## Inner\ninside\n## Equal\nnext\n# Two\nend',
    );
    assert.equal((html.match(/data-preview-section=/g) ?? []).length, 4);
    assert.match(html, /aria-expanded="true"/);
    assert.ok(html.indexOf('Inner') < html.indexOf('Equal'));
    assert.ok(html.indexOf('Equal') < html.indexOf('Two'));
  });
  it('does not treat code fence heading-like text as a section heading', () => {
    const html = preview('# Real\n```md\n# Not a heading\n```\nbody');
    assert.equal((html.match(/data-preview-section=/g) ?? []).length, 1);
    assert.match(html, /# Not a heading/);
  });
  it('does not hoist headings from blockquotes or lists into document sections', () => {
    const html = preview('> # Quoted\n\n- # Listed\n\n# Document');
    assert.equal((html.match(/data-preview-section=/g) ?? []).length, 1);
    assert.match(html, /<blockquote[^>]*>/);
    assert.match(html, /<ul[^>]*>/);
  });
  it('omits the redundant Preview header and header-specific fade while retaining Find', () => {
    const html = renderToStaticMarkup(
      React.createElement(MarkdownPreview, {
        markdown: '# Heading',
        vaultId: 'test-vault',
        notePath: 'current.md',
        appearance: DEFAULT_APPEARANCE,
        onToggleTask: () => {},
        onOpenNote: () => {},
        findOpen: true,
        onCloseFind: () => {},
      } as any),
    );
    assert.doesNotMatch(html, /<h2[^>]*>Preview<\/h2>/);
    assert.doesNotMatch(
      html,
      /markdown-preview-content--(?:find-)?header-fade/,
    );
    assert.match(html, /aria-label="Find in note preview"/);
    assert.match(html, /placeholder="Find in preview"/);
  });

  it('keeps vault-note URLs and sanitizes dangerous schemes through production transform', () => {
    assert.equal(
      markdownPreviewUrlTransform('vault-note:KnownNote'),
      'vault-note:KnownNote',
    );
    assert.equal(markdownPreviewUrlTransform('javascript:alert(1)'), '');
    assert.equal(markdownPreviewUrlTransform('data:text/html,bad'), '');
  });

  it('renders the heading control with accessible button semantics', () => {
    const html = preview('# Heading\ntext');
    assert.match(html, /<h1[^>]*class="[^"]*preview-fold-heading/);
    assert.doesNotMatch(html, /<h1[^>]*class="[^"]*flex items-center/);
    assert.match(
      html,
      /<span class="preview-fold-heading-text">Heading<button type="button" aria-label="Collapse heading" aria-expanded="true" class="preview-heading-fold-control"><svg aria-hidden="true" viewBox="0 0 24 24" class="preview-fold-icon"><path d="m6 9 6 6 6-6"><\/path><\/svg><\/button><\/span>/,
    );
    assert.match(html, /<path d="m6 9 6 6 6-6"><\/path>/);
  });
});

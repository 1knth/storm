import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import React from 'react';
import { DEFAULT_APPEARANCE } from '../appearance';
import type { Appearance } from '../appearance';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  getMatchingItemLabel,
  mergeQuizSessionDrafts,
  getQuizComposerActions,
  QuizMarkdown,
  QuizThinkingIndicator,
  QuizVerdict,
} from './QuizPane';

function render(markdown: string, appearance?: Appearance) {
  return renderToStaticMarkup(
    React.createElement(QuizMarkdown, { children: markdown, appearance }),
  );
}

describe('quiz draft snapshot reconciliation', () => {
  const session = (overrides: Record<string, unknown> = {}) =>
    ({
      id: 'session-a',
      revision: 3,
      freeChatDraft: 'submitted text',
      currentQuestion: { id: 'question-a', status: 'open', textDraft: 'local' },
      ...overrides,
    }) as any;

  it('keeps a successfully cleared sent draft clear through snapshots, but preserves newer typing', () => {
    const beforeSend = session();
    const cleared = { ...beforeSend, freeChatDraft: '' };
    const staleSnapshot = session({ revision: 4, freeChatDraft: 'submitted text' });
    assert.equal(mergeQuizSessionDrafts(staleSnapshot, cleared).freeChatDraft, '');

    const typed = { ...beforeSend, freeChatDraft: 'typed while sending' };
    const laterSnapshot = session({ revision: 5, freeChatDraft: '' });
    assert.equal(
      mergeQuizSessionDrafts(laterSnapshot, typed).freeChatDraft,
      'typed while sending',
    );
  });

  it('does not clear a submitted draft after a failed send', () => {
    const submitted = 'keep on failure';
    const failedSend = { ok: false };
    const current = session({ freeChatDraft: submitted });
    if (failedSend.ok) current.freeChatDraft = '';
    assert.equal(current.freeChatDraft, submitted);
  });

  it('accepts snapshots when content transitions and resets the associated draft', () => {
    const current = session();
    const transitioned = session({
      revision: 4,
      currentQuestion: { id: 'question-b', status: 'open', textDraft: '' },
    });
    const merged = mergeQuizSessionDrafts(transitioned, current);
    assert.equal(merged.currentQuestion.id, 'question-b');
    assert.equal(merged.currentQuestion.textDraft, '');
  });
});

describe('quiz composer feedback layout', () => {
  it('keeps the input row and Continue action without a second disconnected-status row', () => {
    assert.deepEqual(getQuizComposerActions('feedback', false), {
      showContinue: true,
      showDisconnectedStatus: false,
    });
  });

  it('shows Continue without a disconnected status for connected feedback', () => {
    assert.deepEqual(getQuizComposerActions('feedback', true), {
      showContinue: true,
      showDisconnectedStatus: false,
    });
  });

  it('preserves the disconnected status for non-feedback states', () => {
    assert.deepEqual(getQuizComposerActions('open', false), {
      showContinue: false,
      showDisconnectedStatus: true,
    });
  });
});

describe('quiz activity indicator', () => {
  it('renders a visible, accessible thinking status with a CSS spinner', () => {
    const html = renderToStaticMarkup(
      React.createElement(QuizThinkingIndicator, { activity: 'thinking' }),
    );
    assert.match(html, /role="status"/);
    assert.match(html, /aria-live="polite"/);
    assert.match(html, /quiz-activity-spinner/);
    assert.match(html, /Thinking…/);
  });

  it('labels drafting activity without making the decorative spinner accessible', () => {
    const html = renderToStaticMarkup(
      React.createElement(QuizThinkingIndicator, { activity: 'drafting' }),
    );
    assert.match(html, /aria-hidden="true"/);
    assert.match(html, /Drafting…/);
  });
});

describe('quiz verdict renderer', () => {
  it('shows explicit verdict and selected option text', () => {
    const html = renderToStaticMarkup(
      React.createElement(QuizVerdict, {
        verdict: 'incorrect',
        answerLabel: 'Option B',
      }),
    );
    assert.match(html, /Incorrect/);
    assert.match(html, /Selected: Option B/);
    assert.match(html, /aria-label="Incorrect"/);
  });

  it('does not infer a verdict when metadata is absent', () => {
    assert.equal(
      renderToStaticMarkup(React.createElement(QuizVerdict, {})),
      '',
    );
  });
});

describe('quiz Markdown renderer', () => {
  it('styles only nested list markers when a marker color is configured', () => {
    const html = render(
      '- Outer item\n  1. Nested ordered item\n     - Nested bullet',
      { ...DEFAULT_APPEARANCE, listMarkerColor: '#654321' },
    );
    assert.match(html, /class="quiz-markdown"/);
    assert.match(html, /--preview-list-marker-color:#654321/);
    assert.match(html, /<ul>[\s\S]*<ol>[\s\S]*<ul>/);
    assert.match(html, /<li>Outer item/);
    assert.doesNotMatch(html, /<li[^>]*style=/);
  });
  it('renders inline and display math used in quiz prompts and choices', () => {
    const html = render('Solve $x^2=4$.\n\n$$\nx=\\pm 2\n$$');
    assert.match(html, /class="katex"/);
    assert.match(html, /class="katex-display"/);
    assert.match(html, /<math xmlns=/);
  });

  it('renders authored quiz formatting and preserves ordinary line breaks', () => {
    const html = render(
      'A writer argues,\n*“The college should extend evening library hours.”* or `“The college should extend evening library hours.”`\nWhich addition identifies an exception— a **circumstance** in which that recommendation might not apply—rather than **evidence**, a **warrant**, or a **qualifier**?',
    );
    assert.match(
      html,
      /<em>“The college should extend evening library hours\.”<\/em>/,
    );
    assert.match(
      html,
      /<code>“The college should extend evening library hours\.”<\/code>/,
    );
    assert.match(html, /<strong>circumstance<\/strong>/);
    assert.match(html, /<br\s*\/?\s*>/);
  });

  it('routes Mermaid fences to MermaidBlock and preserves ordinary fenced code', () => {
    const mermaid = render('```mermaid\ngraph TD\n  A --> B\n```');
    assert.match(mermaid, /<div[^>]*>/);
    assert.doesNotMatch(mermaid, /<code[^>]*language-mermaid/);

    const ordinary = render('```text\nplain text\n```');
    assert.match(ordinary, /<code class="language-text">plain text/);
  });

  it('applies configured heading, bold, and italic colors', () => {
    const appearance = {
      ...DEFAULT_APPEARANCE,
      headings: ['#101010', ...DEFAULT_APPEARANCE.headings.slice(1)],
      previewBoldColor: '#202020',
      previewItalicColor: '#303030',
    };
    const html = render('# heading\\n\\n**bold** *italic*', appearance);
    assert.match(html, /<h1 style="color:#101010">heading/);
    assert.match(html, /<strong style="color:#202020">bold<\/strong>/);
    assert.match(html, /<em style="color:#303030">italic<\/em>/);
  });

  it('renders learner answers and multiline reasoning through the same safe renderer', () => {
    const answer = render('My answer is $x=2$.\n\nReasoning:\n\n$$\nx^2=4\n$$');
    assert.match(answer, /class="katex"/);
    assert.match(answer, /class="katex-display"/);
    assert.match(answer, /Reasoning:/);
  });

  it('does not activate raw HTML and leaves code math literal', () => {
    const html = render('<img src=x onerror=alert(1)> and `$x$`');
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /<code>\$x\$<\/code>/);
    assert.doesNotMatch(html, /class="katex"/);
  });

  it('handles invalid math without throwing and retains ordinary currency text', () => {
    assert.doesNotThrow(() => render('$\\notacommand{'));
    const currency = render('It costs $5 today.');
    assert.match(currency, /It costs \$5 today\./);
    assert.doesNotMatch(currency, /class="katex"/);
  });
});

describe('matching labels', () => { it('uses alphabetic item and numbered option labels', () => { assert.equal(getMatchingItemLabel('left', 0), 'A'); assert.equal(getMatchingItemLabel('left', 3), 'D'); assert.equal(getMatchingItemLabel('right', 0), '1.'); }); });

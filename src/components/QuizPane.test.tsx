import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QuizMarkdown, QuizThinkingIndicator, QuizVerdict } from './QuizPane';

function render(markdown: string) {
  return renderToStaticMarkup(
    React.createElement(QuizMarkdown, null, markdown),
  );
}

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

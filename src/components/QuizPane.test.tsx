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
  QuizMarkdownAppearanceContext,
  QuizThinkingIndicator,
  QuizVerdict,
} from './QuizPane';

function render(markdown: string, appearance?: Appearance) {
  return renderToStaticMarkup(
    React.createElement(QuizMarkdown, { children: markdown, appearance }),
  );
}

describe('quiz Markdown links', () => {
  it('memoizes the Markdown renderer type', () => {
    assert.equal(QuizMarkdown.$$typeof, Symbol.for('react.memo'));
    assert.equal(React.createElement(QuizMarkdown).type, QuizMarkdown);
  });
  it('opens only absolute HTTP(S) links in a new window for the Electron external-link handler', () => {
    const html = render('[secure](https://example.com/path) [plain](http://example.org)');
    assert.match(html, /href="https:\/\/example\.com\/path" target="_blank" rel="noopener noreferrer"/);
    assert.match(html, /href="http:\/\/example\.org\/" target="_blank" rel="noopener noreferrer"/);
  });

  it('renders unsupported, malformed, and relative destinations as inert text', () => {
    const html = render(
      '[file](file:///tmp/a) [script](javascript:alert%281%29) [data](data:text/html,x) [custom](storm://open) [relative](../note) [bad](http://[)',
    );
    assert.doesNotMatch(html, /<a\\b/);
    assert.match(html, /<span>file<\/span>/);
    assert.match(html, /<span>relative<\/span>/);
    assert.match(html, /<span>bad<\/span>/);
  });
});

describe('quiz Markdown appearance inheritance', () => {
  it('inherits saved appearance from its pane context when no prop is passed', () => {
    const appearance = {
      ...DEFAULT_APPEARANCE,
      headings: ['#111111', ...DEFAULT_APPEARANCE.headings.slice(1)],
    };
    const html = renderToStaticMarkup(
      React.createElement(
        QuizMarkdownAppearanceContext.Provider,
        { value: appearance },
        React.createElement(QuizMarkdown, { children: '# Heading' }),
      ),
    );
    assert.match(html, /<h1[^>]*color:#111111/);
    assert.doesNotMatch(render('# Heading'), /color:#111111/);
  });
});

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
describe('quiz word reveal', () => {
  it('reveals text nodes in order while preserving whitespace and inline markup', () => {
    const html = renderToStaticMarkup(
      React.createElement(QuizMarkdown, {
        reveal: true,
        children: 'one **bold word**\nnext `code`',
      }),
    );

    assert.match(html, /class="quiz-reveal-word"/);
    assert.match(html, /<strong><span><span class="quiz-reveal-word"/);
    assert.match(html, /<code>code<\/code>/);
    assert.ok(html.includes('<strong>'));
    assert.ok(html.includes('<br/><span>\n</span>'));
    assert.match(html, /--quiz-word-index:0/);
    assert.match(html, /--quiz-word-index:1/);
    assert.match(html, /--quiz-word-index:2/);
  });

  it('keeps unordered, ordered, and nested list markers aligned to each item first word', () => {
    const html = renderToStaticMarkup(
      React.createElement(QuizMarkdown, {
        reveal: true,
        children: '- alpha **bold**\n- beta\n\n1. first\n   1. nested',
      }),
    );

    assert.equal((html.match(/quiz-reveal-list-item/g) ?? []).length, 4);
    assert.equal((html.match(/quiz-reveal-marker/g) ?? []).length, 4);
    assert.match(html, /<li class="quiz-reveal-list-item"><span class="quiz-reveal-marker" style="--quiz-word-index:0" aria-hidden="true"><\/span><span><span class="quiz-reveal-word"/);
    assert.match(html, /<ol>/);
    assert.match(html, /<ul>/);
  });

  it('keeps GFM task checkboxes semantic and reveals them with their first text, without duplicate bullets', () => {
    const html = renderToStaticMarkup(
      React.createElement(QuizMarkdown, {
        reveal: true,
        children: '- [ ] unchecked\n- [x] checked\n  - [ ] nested',
      }),
    );

    assert.equal((html.match(/quiz-reveal-marker/g) ?? []).length, 0);
    assert.equal((html.match(/quiz-reveal-task-checkbox/g) ?? []).length, 3);
    assert.match(html, /type="checkbox" disabled="" class="quiz-reveal-task-checkbox" style="--quiz-word-index:0"/);
    assert.match(html, /type="checkbox" disabled="" class="quiz-reveal-task-checkbox" style="--quiz-word-index:1" checked=""/);
    assert.doesNotMatch(html, /aria-hidden/);
  });

  it('does not add synthetic markers to code-only list items', () => {
    const html = renderToStaticMarkup(
      React.createElement(QuizMarkdown, {
        reveal: true,
        children: '- `code-only`',
      }),
    );

    assert.doesNotMatch(html, /quiz-reveal-marker/);
    assert.match(html, /<li><code>code-only<\/code><\/li>/);
  });

  it('does not wrap code or math while revealing surrounding prose', () => {
    const html = renderToStaticMarkup(
      React.createElement(QuizMarkdown, {
        reveal: true,
        children: 'before `literal` $x^2$ after',
      }),
    );

    assert.match(html, /<code>literal<\/code>/);
    assert.match(html, /class="katex"/);
    assert.match(html, /quiz-reveal-word/);
    assert.doesNotMatch(html, /quiz-reveal-word[^>]*>literal/);
    assert.doesNotMatch(html, /quiz-reveal-word[^>]*>x/);
  });
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

  it('keeps learner list paragraphs as separate blocks, including nested ordered and unordered lists', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        'div',
        { className: 'quiz-learner-markdown' },
        React.createElement(QuizMarkdown, {
          children:
            '- First paragraph\n\n  Second paragraph\n  - Nested unordered\n\n    Nested paragraph\n\n1. Ordered item\n\n   Continued ordered paragraph',
        }),
      ),
    );

    assert.match(html, /class="quiz-learner-markdown"><div class="quiz-markdown"><ul>/);
    assert.match(html, /<li>\s*<p>First paragraph<\/p>\s*<p>Second paragraph<\/p>\s*<ul>\s*<li>\s*<p>Nested unordered<\/p>\s*<p>Nested paragraph<\/p>\s*<\/li>\s*<\/ul>\s*<\/li>/);
    assert.match(html, /<ol>\s*<li>\s*<p>Ordered item<\/p>\s*<p>Continued ordered paragraph<\/p>\s*<\/li>\s*<\/ol>/);
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

describe('quiz currency rendering', () => {
  it('keeps the fee-category question currency and inline formatting literal', () => {
    const html = render(
      'A program should print **exactly one** fee category. Orders of at least $100 qualify for `Free`; orders from $50 up to $100 qualify for `Reduced`; smaller orders use `Standard`.\n\n```python\nif total >= 50:\n    print("Reduced")\n```',
    );
    assert.match(html, /\$100 qualify for <code>Free<\/code>/);
    assert.match(html, /\$50 up to \$100 qualify for <code>Reduced<\/code>/);
    assert.match(html, /<strong>exactly one<\/strong>/);
    assert.match(html, /<code class="language-python">/);
    assert.doesNotMatch(html, /katex/);
  });

  it('preserves equations alongside currency, code, and escaped dollars', () => {
    const html = render(
      'Pay $5 or $10, then solve $2 + 2$ and $x^2$. Range: $5–$10.\n\n`$5 and $10`\n\n```txt\n$5 and $10\n```\n\nEscaped: \\$5 and \\$10.\n\n$$\n2 + 2\n$$',
    );
    assert.match(html, /Pay \$5 or \$10, then solve/);
    assert.match(html, /Range: \$5–\$10\./);
    assert.equal((html.match(/class="katex"/g) ?? []).length, 3);
    assert.match(html, /class="katex-display"/);
    assert.match(html, /<code>\$5 and \$10<\/code>/);
    assert.match(html, /<code class="language-txt">\$5 and \$10/);
    assert.match(html, /Escaped: \$5 and \$10\./);
  });

  it('keeps numeric equations with trailing spaces and double-dollar math', () => {
    const html = render('$2 + 2 $ and $$2 $$');
    assert.equal((html.match(/class="katex"/g) ?? []).length, 2);
  });
});

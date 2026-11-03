import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import React from 'react';
import { DEFAULT_APPEARANCE } from '../appearance';
import {
  getQuizComposerIntent,
  handleQuizComposerEnter,
  shouldClearSubmittedDraft,
} from './quizComposer';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  getMatchingItemLabel,
  mergeQuizSessionDrafts,
  getQuizActivityIndicator,
  getQuizComposerActions,
  updateQuizRevealHistory,
  QuizMarkdown,
  QuizMarkdownAppearanceContext,
  QuizThinkingIndicator,
  scrollQuizTranscriptToBottom,
  QuizVerdict,
  QuizAnswerActions,
  QuizLearningTag,
  quizRevealStepMs,
  QUIZ_REVEAL_BUDGET_MS,
  QUIZ_REVEAL_STEP_MS,
} from './QuizPane';

function render(markdown: string) {
  return renderToStaticMarkup(
    React.createElement(QuizMarkdown, null, markdown),
  );
}

describe('quiz Markdown links', () => {
  it('opens only absolute HTTP(S) links in a new window for the Electron external-link handler', () => {
    const html = render(
      '[secure](https://example.com/path) [plain](http://example.org)',
    );
    assert.match(
      html,
      /href="https:\/\/example\.com\/path" target="_blank" rel="noopener noreferrer"/,
    );
    assert.match(
      html,
      /href="http:\/\/example\.org\/" target="_blank" rel="noopener noreferrer"/,
    );
  });

  it('renders unsupported, malformed, and relative destinations as inert text', () => {
    const html = render(
      '[file](file:///tmp/a) [script](javascript:alert%281%29) [data](data:text/html,x) [custom](storm://open) [relative](../note) [bad](http://[)',
    );
    assert.doesNotMatch(html, /<a\b/);
    assert.match(html, /<span>file<\/span>/);
    assert.match(html, /<span>relative<\/span>/);
    assert.match(html, /<span>bad<\/span>/);
  });
});

describe('quiz transcript reveal history', () => {
  it('does not reveal historical messages through A→B→A session reopening', () => {
    const history = {
      sessionId: null as string | null,
      ids: new Set<string>(),
    };
    const a = [
      { id: 'a-old', role: 'agent' },
      { id: 'a-new', role: 'agent' },
    ];
    const b = [{ id: 'b-old', role: 'agent' }];

    assert.deepEqual(updateQuizRevealHistory(history, 'A', a, true), []);
    assert.deepEqual(updateQuizRevealHistory(history, 'B', b, true), []);
    assert.deepEqual(updateQuizRevealHistory(history, 'A', a, true), []);
    assert.deepEqual(
      updateQuizRevealHistory(history, 'A', [
        ...a,
        { id: 'a-live', role: 'agent' },
      ]),
      ['a-live'],
    );
  });
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
    assert.match(
      html,
      /<li class="quiz-reveal-list-item"><span class="quiz-reveal-marker" style="--quiz-word-index:0[^"]*" aria-hidden="true"><\/span><span><span class="quiz-reveal-word"/,
    );
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
    assert.match(
      html,
      /type="checkbox" disabled="" class="quiz-reveal-task-checkbox" style="--quiz-word-index:0[^"]*"/,
    );
    assert.match(
      html,
      /type="checkbox" disabled="" class="quiz-reveal-task-checkbox" style="--quiz-word-index:1[^"]*" checked=""/,
    );
    assert.doesNotMatch(html, /aria-hidden/);
  });

  it('aligns synthetic markers with atomic code-only list items', () => {
    const html = renderToStaticMarkup(
      React.createElement(QuizMarkdown, {
        reveal: true,
        children: '- `code-only`',
      }),
    );

    assert.match(html, /quiz-reveal-marker" style="--quiz-word-index:0/);
    assert.match(
      html,
      /class="quiz-reveal-unit" style="--quiz-word-index:0[^"]*"><code>code-only<\/code>/,
    );
  });

  it('wraps inline and display math atomically in reveal order', () => {
    const html = renderToStaticMarkup(
      React.createElement(QuizMarkdown, {
        reveal: true,
        children: 'before $x^2$ after\n\n$$\ny=2\n$$',
      }),
    );

    assert.match(
      html,
      /class="quiz-reveal-unit" style="--quiz-word-index:1[^"]*"><span class="katex"/,
    );
    assert.match(
      html,
      /class="quiz-reveal-unit" style="--quiz-word-index:3[^"]*"><span class="katex-display"/,
    );
  });

  it('keeps code untouched and reveals rendered math as one atomic unit', () => {
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
    assert.match(
      html,
      /class="quiz-reveal-unit" style="--quiz-word-index:2[^"]*"><span class="katex"/,
    );
    assert.match(html, /--quiz-word-index:3/);
  });
});

describe('quiz draft snapshot reconciliation', () => {
  const session = (overrides: Record<string, unknown> = {}) =>
    ({
      id: 'session-a',
      revision: 3,
      freeChatDraft: 'latest chat',
      currentQuestion: {
        id: 'question-a',
        status: 'open',
        selectedChoiceId: 'choice-local',
        reasoningDraft: 'reason-local',
        textDraft: 'answer-local',
        matchesDraft: { left: 'right-local' },
      },
      currentPrompt: {
        id: 'prompt-a',
        selectedChoiceId: 'prompt-choice-local',
        detailDraft: 'detail-local',
      },
      ...overrides,
    }) as any;

  it('preserves all local draft fields against stale same-content snapshots', () => {
    const current = session();
    const stale = session({
      revision: 2,
      freeChatDraft: 'old chat',
      currentQuestion: { ...current.currentQuestion, reasoningDraft: 'old' },
      currentPrompt: { ...current.currentPrompt, detailDraft: 'old' },
    });

    assert.equal(mergeQuizSessionDrafts(stale, current), current);
  });

  it('keeps current drafts on matching content IDs, but accepts new content and sessions', () => {
    const current = session();
    const incoming = session({
      revision: 4,
      freeChatDraft: '',
      currentQuestion: { ...current.currentQuestion, reasoningDraft: '' },
      currentPrompt: { ...current.currentPrompt, detailDraft: '' },
    });
    const merged = mergeQuizSessionDrafts(incoming, current);
    assert.equal(merged.freeChatDraft, 'latest chat');
    assert.equal(merged.currentQuestion.reasoningDraft, 'reason-local');
    assert.equal(merged.currentPrompt.detailDraft, 'detail-local');

    const nextContent = session({
      revision: 4,
      currentQuestion: { id: 'question-b', status: 'open', textDraft: '' },
      currentPrompt: { id: 'prompt-b', detailDraft: '' },
    });
    const transitioned = mergeQuizSessionDrafts(nextContent, current);
    assert.equal(transitioned.currentQuestion.id, 'question-b');
    assert.equal(transitioned.currentQuestion.textDraft, '');
    assert.equal(transitioned.currentPrompt.detailDraft, '');

    const otherSession = session({ id: 'session-b' });
    assert.equal(mergeQuizSessionDrafts(otherSession, current), otherSession);
  });

  it('keeps a successfully cleared sent draft clear through snapshots, but preserves newer typing', () => {
    const sent = 'submitted text';
    const beforeSend = session({ freeChatDraft: sent });
    assert.equal(shouldClearSubmittedDraft(sent, sent), true);

    const cleared = { ...beforeSend, freeChatDraft: '' };
    const staleSnapshot = session({ revision: 4, freeChatDraft: sent });
    assert.equal(
      mergeQuizSessionDrafts(staleSnapshot, cleared).freeChatDraft,
      '',
    );

    const newerDraft = 'typed while sending';
    assert.equal(shouldClearSubmittedDraft(newerDraft, sent), false);
    const typed = { ...beforeSend, freeChatDraft: newerDraft };
    const laterSnapshot = session({ revision: 5, freeChatDraft: '' });
    assert.equal(
      mergeQuizSessionDrafts(laterSnapshot, typed).freeChatDraft,
      newerDraft,
    );
  });

  it('does not clear a submitted draft after a failed send', () => {
    const submitted = 'keep on failure';
    // The send-success path is gated by result.ok; a failure never calls the
    // clear predicate or mutates either draft representation.
    const failedSend = { ok: false };
    const current = session({ freeChatDraft: submitted });
    if (failedSend.ok) {
      assert.equal(
        shouldClearSubmittedDraft(current.freeChatDraft, submitted),
        true,
      );
    }
    assert.equal(current.freeChatDraft, submitted);
    assert.equal(
      shouldClearSubmittedDraft(current.freeChatDraft, 'other'),
      false,
    );
  });

  it('does not resurrect drafts for answered or removed questions', () => {
    const current = session();
    const answered = session({
      revision: 4,
      currentQuestion: {
        ...current.currentQuestion,
        status: 'answered',
        reasoningDraft: undefined,
      },
      currentPrompt: null,
    });
    const merged = mergeQuizSessionDrafts(answered, current);
    assert.equal(merged.currentQuestion.status, 'answered');
    assert.equal(merged.currentQuestion.reasoningDraft, undefined);
    assert.equal(merged.currentPrompt, null);
  });
});

describe('quiz transcript autoscroll', () => {
  it('follows the bottom again after composer growth increases scroll height', () => {
    const pane = { scrollHeight: 400, scrollTop: 400 };

    pane.scrollHeight = 560;
    scrollQuizTranscriptToBottom(pane);

    assert.equal(pane.scrollTop, 560);
  });
});

describe('selected prompt composer submission', () => {
  it('routes an empty chat draft with a selected prompt to prompt response', () => {
    assert.equal(getQuizComposerIntent('', 0, true), 'prompt');
    assert.equal(getQuizComposerIntent('optional detail', 0, true), 'message');
  });

  it('sends on Enter when a prompt is selected, without auto-submitting', () => {
    let sent = 0;
    const event = {
      key: 'Enter',
      shiftKey: false,
      isComposing: false,
      preventDefault() {},
    };
    handleQuizComposerEnter(event, true, () => sent++);
    assert.equal(sent, 1);
    handleQuizComposerEnter({ ...event, shiftKey: true }, true, () => sent++);
    handleQuizComposerEnter(event, false, () => sent++);
    assert.equal(sent, 1);
  });
});

describe('matching question labels', () => {
  it('uses letters for match items and numbers for match options', () => {
    assert.equal(getMatchingItemLabel('left', 0), 'A');
    assert.equal(getMatchingItemLabel('left', 3), 'D');
    assert.equal(getMatchingItemLabel('right', 0), '1.');
    assert.equal(getMatchingItemLabel('right', 3), '4.');
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
  it('uses authoritative waiting state, prefers live agent activity, and hides it while disconnected', () => {
    const session = {
      status: 'connected',
      awaitingAgent: true,
      activity: { state: 'idle', updatedAt: 'now' },
    } as const;
    assert.equal(getQuizActivityIndicator(session), 'waiting');
    assert.equal(
      getQuizActivityIndicator({
        ...session,
        activity: { state: 'thinking', updatedAt: 'now' },
      }),
      'thinking',
    );
    assert.equal(
      getQuizActivityIndicator({ ...session, status: 'disconnected' }),
      undefined,
    );
    const html = renderToStaticMarkup(
      React.createElement(QuizThinkingIndicator, { activity: 'waiting' }),
    );
    assert.match(html, /Waiting for agent…/);
    assert.match(html, /quiz-activity-spinner/);
  });

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

  it('shows submitted confidence with feedback and while waiting for a verdict', () => {
    const feedback = renderToStaticMarkup(
      React.createElement(QuizVerdict, { verdict: 'correct', confidence: 70 }),
    );
    assert.match(feedback, /Correct/);
    assert.match(feedback, /Confidence 70%/);
    const answered = renderToStaticMarkup(
      React.createElement(QuizVerdict, { confidence: 0 }),
    );
    assert.match(answered, /Confidence 0%/);
    assert.doesNotMatch(answered, /Correct|Incorrect|Partially correct/);
  });
});

function elements(node: React.ReactNode): React.ReactElement<any>[] {
  return React.Children.toArray(node).flatMap((child) => {
    if (!React.isValidElement<{ children?: React.ReactNode }>(child)) return [];
    return [child, ...elements(child.props.children)];
  });
}

describe('question answer footer', () => {
  const props = {
    questionId: 'question-a',
    confidence: null as number | null,
    answerComplete: false,
    connected: true,
    busy: false,
    onConfidenceChange: (_value: number) => {},
    onSkip: () => {},
    onSubmit: () => {},
  };
  const controls = (overrides: Partial<typeof props> = {}) =>
    elements(QuizAnswerActions({ ...props, ...overrides }));
  const submit = (overrides: Partial<typeof props> = {}) =>
    controls(overrides).find(
      (element) =>
        element.type === 'button' && element.props.children === 'Submit answer',
    )!;

  it('enables Submit only with an answer, explicit confidence, connection, and no pending request', () => {
    assert.equal(submit().props.disabled, true);
    assert.equal(submit({ answerComplete: true }).props.disabled, true);
    assert.equal(submit({ confidence: 70 }).props.disabled, true);
    assert.equal(
      submit({ answerComplete: true, confidence: 70 }).props.disabled,
      false,
    );
    assert.equal(
      submit({ answerComplete: true, confidence: 0 }).props.disabled,
      false,
    );
    assert.equal(
      submit({ answerComplete: true, confidence: 70, connected: false }).props
        .disabled,
      true,
    );
    assert.equal(
      submit({ answerComplete: true, confidence: 70, busy: true }).props
        .disabled,
      true,
    );
  });

  it('starts unrated with an associated label, a status hint, and a neutral slider', () => {
    const html = renderToStaticMarkup(
      React.createElement(QuizAnswerActions, props),
    );
    assert.match(
      html,
      /<label for="quiz-confidence-question-a"[^>]*>How confident are you\?/,
    );
    assert.match(
      html,
      /type="range" min="0" max="100" step="5" aria-valuetext="Not rated"/,
    );
    assert.match(html, /quiz-confidence-slider--unrated/);
    assert.match(html, /role="status"/);
    assert.match(
      html,
      /Complete your answer and rate your confidence to submit\./,
    );
    const rated = renderToStaticMarkup(
      React.createElement(QuizAnswerActions, {
        ...props,
        answerComplete: true,
        confidence: 70,
      }),
    );
    assert.match(rated, /70% · Fairly sure/);
    assert.doesNotMatch(rated, /role="status"|quiz-confidence-slider--unrated/);
  });

  it('commits an unchanged thumb value on pointer-up and keyboard navigation, without rating on Tab', () => {
    const ratings: number[] = [];
    const slider = controls({
      onConfidenceChange: (value) => ratings.push(value),
    }).find((element) => element.type === 'input')!;
    const currentTarget = { valueAsNumber: 50 };
    slider.props.onPointerUp({ currentTarget });
    slider.props.onKeyUp({ key: 'ArrowRight', currentTarget });
    slider.props.onKeyUp({ key: 'Home', currentTarget: { valueAsNumber: 0 } });
    slider.props.onKeyUp({ key: 'Tab', currentTarget });
    slider.props.onChange({ currentTarget: { valueAsNumber: 75 } });
    assert.deepEqual(ratings, [50, 50, 0, 75]);
  });

  it('places low-emphasis Skip alongside Submit in the question footer with separate actions', () => {
    let skips = 0;
    let submissions = 0;
    const footer = controls({
      answerComplete: true,
      confidence: 70,
      onSkip: () => skips++,
      onSubmit: () => submissions++,
    });
    const skip = footer.find(
      (element) =>
        element.type === 'button' && element.props.children === 'Skip question',
    )!;
    const primary = footer.find(
      (element) =>
        element.type === 'button' && element.props.children === 'Submit answer',
    )!;
    assert.equal(skip.props.title, 'Skip this question without a grade');
    assert.equal(skip.props.type, 'button');
    assert.doesNotMatch(skip.props.className, /quiz-action-button/);
    assert.match(primary.props.className, /quiz-action-button/);
    skip.props.onClick();
    primary.props.onClick();
    assert.equal(skips, 1);
    assert.equal(submissions, 1);
    assert.equal(getQuizComposerIntent(''), null);
    assert.equal(getQuizComposerIntent('A chat message'), 'message');
  });
});

describe('question learning tag', () => {
  it('shows a subtle level and support label with concepts only in the tooltip', () => {
    for (const [support, suffix] of [
      ['independent', ''],
      ['hinted', ' · with hints'],
      ['worked', ' · worked example'],
    ] as const) {
      const html = renderToStaticMarkup(
        React.createElement(QuizLearningTag, {
          learning: { level: 'apply', support, concepts: ['loop-condition'] },
        }),
      );
      assert.match(html, /title="loop-condition"/);
      assert.ok(html.endsWith(`>Apply${suffix}</p>`));
    }
    assert.equal(
      renderToStaticMarkup(React.createElement(QuizLearningTag, {})),
      '',
    );
  });
});

describe('quiz Markdown renderer', () => {
  it('contains wide tables in a keyboard-scrollable region and preserves cell formatting and alignment', () => {
    const markdown = [
      'Five need correction:',
      '',
      '| Question | Your answer | Correct answer | Why |',
      '| ---: | :---: | :---: | :--- |',
      '| 2 | B | **A** | **Validity** concerns whether the conclusion follows from the premises. |',
      '',
      'All other answers are correct.',
    ].join('\n');

    for (const reveal of [false, true]) {
      const html = renderToStaticMarkup(
        React.createElement(QuizMarkdown, { children: markdown, reveal }),
      );
      assert.match(
        html,
        /<div class="quiz-markdown-table-scroll" tabindex="0" role="region" aria-label="Table"><table>/,
      );
      assert.match(html, /<th style="text-align:right">/);
      assert.match(html, /<td style="text-align:center"><strong>/);
      assert.doesNotMatch(html, /<(?:table|thead|tbody|tr)>\s*<span/);
      assert.match(html, /<\/table><\/div>(?:\s|<span>\s*<\/span>)*<p>/);
      assert.doesNotMatch(html, /<table[^>]* node=/);
    }
  });

  it('exports one stable React memo component with default shallow-prop comparison', () => {
    assert.equal(QuizMarkdown.$$typeof, Symbol.for('react.memo'));
    assert.equal(typeof QuizMarkdown.type, 'function');
    assert.equal(
      React.createElement(QuizMarkdown, { children: 'same text' }).type,
      QuizMarkdown,
    );
  });

  it('inherits configured appearance from the pane context without an appearance prop', () => {
    const appearance = {
      ...DEFAULT_APPEARANCE,
      headings: ['#111111', '#222222', ...DEFAULT_APPEARANCE.headings.slice(2)],
      previewBoldColor: '#abcdef',
      previewItalicColor: '#123456',
      listMarkerColor: '#654321',
    };
    const html = renderToStaticMarkup(
      React.createElement(
        QuizMarkdownAppearanceContext.Provider,
        { value: appearance },
        React.createElement(QuizMarkdown, {
          children: '# Heading\n\n**bold** *italic*\n\n- item',
        }),
      ),
    );
    assert.match(html, /<h1[^>]*color:#111111/);
    assert.match(html, /<strong[^>]*color:#abcdef/);
    assert.match(html, /<em[^>]*color:#123456/);
    assert.match(html, /--preview-list-marker-color:#654321/);

    const fallbackHtml = render('# Heading\n\n**bold** *italic*\n\n- item');
    assert.match(
      fallbackHtml,
      new RegExp(`color:${DEFAULT_APPEARANCE.headings[0]}`),
    );
    assert.doesNotMatch(
      fallbackHtml,
      /color:#abcdef|color:#123456|--preview-list-marker-color:#654321/,
    );
  });

  it('applies configured appearance to headings, emphasis, and nested list markers only', () => {
    const appearance = {
      ...DEFAULT_APPEARANCE,
      headings: ['#111111', '#222222', ...DEFAULT_APPEARANCE.headings.slice(2)],
      previewBoldColor: '#abcdef',
      previewItalicColor: '#123456',
      listMarkerColor: '#654321',
    };
    const html = renderToStaticMarkup(
      React.createElement(QuizMarkdown, {
        appearance,
        children:
          '# Heading\n\n**bold** *italic*\n\n- outer\n  - inner\n\n1. numbered',
      }),
    );
    assert.match(html, /<h1[^>]*color:#111111/);
    assert.match(html, /<strong[^>]*color:#abcdef/);
    assert.match(html, /<em[^>]*color:#123456/);
    assert.match(html, /--preview-list-marker-color:#654321/);
    assert.match(html, /<li>outer/);
    assert.match(html, /<li>inner/);
    assert.match(html, /<li>numbered/);
    assert.doesNotMatch(html, /<p[^>]*style=/);
  });

  it('routes Mermaid fences to MermaidBlock and keeps ordinary fences as code', () => {
    const html = render(
      '```mermaid\ngraph TD; A-->B\n```\n\n```js\nconst answer = 42;\n```',
    );
    assert.match(html, /aria-label="Rendering diagram"/);
    assert.match(html, /<pre[^>]*><code class="language-js">const answer = 42/);
    assert.doesNotMatch(html, /<code class="language-mermaid">/);
  });

  it('wraps Mermaid fence placeholders before reveal processing while normal Markdown stays unanimated', () => {
    const normal = render('```mermaid\ngraph TD; A-->B\n```');
    const revealed = renderToStaticMarkup(
      React.createElement(QuizMarkdown, {
        reveal: true,
        children: '```mermaid\ngraph TD; A-->B\n```',
      }),
    );

    assert.match(normal, /aria-label="Rendering diagram"/);
    assert.match(revealed, /aria-label="Rendering diagram"/);
    assert.doesNotMatch(normal, /quiz-reveal-/);
    assert.doesNotMatch(revealed, /quiz-reveal-word/);
    assert.match(
      revealed,
      /class="quiz-reveal-unit" style="--quiz-word-index:0[^"]*"/,
    );
    assert.doesNotMatch(revealed, /language-mermaid/);
  });

  it('renders inline and display math used in quiz prompts and choices', () => {
    const html = render('Solve $x^2=4$.\n\n$$\nx=\\pm 2\n$$');
    assert.match(html, /class="katex"/);
    assert.match(html, /class="katex-display"/);
    assert.match(html, /<math xmlns=/);
  });

  it('renders LaTeX bracket and parenthesis delimiters in quiz content', () => {
    const html = render(String.raw`Simplify:
\[
\neg(p\lor q)\lor(p\land\neg q)
\]

Explain \(p\lor q\).`);
    assert.match(html, /class="katex-display"/);
    assert.equal((html.match(/class="katex"/g) ?? []).length, 2);
    assert.doesNotMatch(html, /katex-error/);
  });

  it('keeps bracket display math inside its list item, quotation, or sentence', () => {
    const list = render(
      String.raw`1. Solve:
   \[
   x^2 = 4
   \]

2. Next step`,
    );
    assert.match(list, /<li>\s*<p>Solve:<\/p>\s*<span class="katex-display"/);
    assert.match(list, /<li>\s*(?:<p>)?Next step/);
    assert.doesNotMatch(list, /<\/ol>[\s\S]*katex/);
    assert.equal((list.match(/class="katex-display"/g) ?? []).length, 1);
    assert.doesNotMatch(list, /\$\$/);

    const quoted = render(String.raw`> Shown:
> \[
> y = 2
> \]`);
    assert.match(
      quoted,
      /<blockquote>[\s\S]*<span class="katex-display"[\s\S]*<\/blockquote>/,
    );

    const inline = render(String.raw`Text \[a+b\] tail`);
    assert.match(inline, /<p>Text <span class="katex"[\s\S]*tail<\/p>/);
    assert.doesNotMatch(inline, /\$\$/);
  });

  it('preserves LaTeX delimiters inside code and escaped delimiters', () => {
    const html = render('`\\(x\\)`\n\n```tex\n\\[x\\]\n```\n\n\\\\(x\\\\)');
    assert.doesNotMatch(html, /class="katex"/);
    assert.match(html, /<code>\\\(x\\\)<\/code>/);
  });

  it('renders LaTeX math alongside ordinary currency', () => {
    const html = render(String.raw`Solve \(x^2=4\). Pay $5 or $10.`);
    assert.equal((html.match(/class="katex"/g) ?? []).length, 1);
    assert.match(html, /Pay \$5 or \$10/);
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

  it('keeps agent list paragraphs as separate blocks, including nested ordered and unordered lists', () => {
    const html = render(
      '- First paragraph\n\n  Second paragraph\n  - Nested unordered\n\n    Nested paragraph\n\n1. Ordered item\n\n   Continued ordered paragraph',
    );

    assert.match(html, /class="quiz-agent-markdown"><ul>/);
    assert.match(
      html,
      /<li>\s*<p>First paragraph<\/p>\s*<p>Second paragraph<\/p>\s*<ul>\s*<li>\s*<p>Nested unordered<\/p>\s*<p>Nested paragraph<\/p>\s*<\/li>\s*<\/ul>\s*<\/li>/,
    );
    assert.match(
      html,
      /<ol>\s*<li>\s*<p>Ordered item<\/p>\s*<p>Continued ordered paragraph<\/p>\s*<\/li>\s*<\/ol>/,
    );
  });

  it('renders agent math and multiline explanations through the same safe renderer', () => {
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

  it('keeps react-markdown source nodes out of rendered attributes', () => {
    const html = render(
      '# Heading\n\n**bold** *italic* [link](https://example.com)\n\n```js\nconst x = 1;\n```\n\n| a |\n| --- |\n| 1 |\n\nText[^1]\n\n[^1]: footnote\n',
    );
    assert.doesNotMatch(html, / node=/);
  });

  it('paces word reveal so long answers still finish within the reveal budget', () => {
    assert.equal(quizRevealStepMs(1), QUIZ_REVEAL_STEP_MS);
    assert.equal(quizRevealStepMs(20), QUIZ_REVEAL_STEP_MS);
    const words = Array.from({ length: 120 }, (_, index) => `word${index}`);
    const html = renderToStaticMarkup(
      React.createElement(QuizMarkdown, {
        reveal: true,
        children: words.join(' '),
      }),
    );
    const step = Number(/--quiz-word-step:([\d.]+)ms/.exec(html)?.[1]);
    assert.equal(step, quizRevealStepMs(words.length));
    assert.ok(step < QUIZ_REVEAL_STEP_MS);
    assert.ok((words.length - 1) * step <= QUIZ_REVEAL_BUDGET_MS);
    assert.equal((html.match(/--quiz-word-step:/g) ?? []).length, words.length);
  });
});

describe('quiz callouts', () => {
  it('renders a labelled callout with its own title and body', () => {
    const html = render('> [!NOTE]\n> Mind the loop guard.');
    assert.match(
      html,
      /<div class="quiz-callout quiz-callout--note">\s*<div class="quiz-callout-title">Note<\/div>/,
    );
    assert.match(
      html,
      /<div class="quiz-callout-body">\s*<p>Mind the loop guard\.<\/p>/,
    );
  });

  it('keeps an authored title, its inline formatting, and the whole body', () => {
    const html = render(
      '> [!TIP] Spotting the **invariant**\n> Check the guard.\n>\n> - one\n> - two',
    );
    assert.match(
      html,
      /quiz-callout-title">Spotting the <strong[^>]*>invariant<\/strong><\/div>/,
    );
    assert.match(html, /<p>Check the guard\.<\/p>/);
    assert.match(html, /<li>one<\/li>/);
    assert.match(html, /quiz-callout--tip/);
  });

  it('collapses hints and honours explicit open and closed markers', () => {
    const hint = render('> [!HINT]\n> Try $x=2$.');
    assert.match(
      hint,
      /<details class="quiz-callout quiz-callout--hint">\s*<summary class="quiz-callout-title">Hint<\/summary>/,
    );
    assert.doesNotMatch(hint, /<details[^>]* open/);
    assert.match(hint, /class="katex"/);

    const closed = render(
      '> [!EXAMPLE]- Worked solution\n> Start from the base case.',
    );
    assert.match(
      closed,
      /<details class="quiz-callout quiz-callout--example">/,
    );
    assert.doesNotMatch(closed, /<details[^>]* open/);

    const open = render('> [!warning]+ Careful\n> Mind the sign.');
    assert.match(open, /<details[^>]* open=""/);
    assert.match(open, /quiz-callout--warning/);
    assert.match(
      open,
      /<summary class="quiz-callout-title">Careful<\/summary>/,
    );
  });

  it('leaves ordinary and unrecognized blockquotes untouched', () => {
    assert.match(render('> ordinary quotation'), /<blockquote>/);
    const unknown = render('> [!FOO]\n> still a quotation');
    assert.match(unknown, /<blockquote>/);
    assert.match(unknown, /\[!FOO\]/);
    assert.doesNotMatch(unknown, /quiz-callout/);
  });

  it('does not turn an answer choice into a titled panel', () => {
    const choice = renderToStaticMarkup(
      React.createElement(QuizMarkdown, {
        choice: true,
        children: '> [!NOTE]\n> inside a choice',
      }),
    );
    assert.match(choice, /<blockquote>/);
    assert.doesNotMatch(choice, /quiz-callout/);
  });

  it('nests a hint inside a callout and reveals callout text word by word', () => {
    const nested = render(
      '> [!NOTE] Outer\n> text\n>\n> > [!HINT] inner\n> > secret',
    );
    assert.match(
      nested,
      /quiz-callout--note[\s\S]*<details class="quiz-callout quiz-callout--hint">[\s\S]*secret/,
    );

    const revealed = renderToStaticMarkup(
      React.createElement(QuizMarkdown, {
        reveal: true,
        children: '> [!TIP] Look here\n> alpha beta',
      }),
    );
    assert.match(
      revealed,
      /quiz-callout-title"><span><span class="quiz-reveal-word"[^>]*>Look<\/span>/,
    );
    assert.equal((revealed.match(/quiz-reveal-word/g) ?? []).length, 4);
  });
});

describe('quiz choice formatting', () => {
  it('renders ATX and setext headings as body text while retaining inline formatting', () => {
    for (const markdown of [
      '# **Check** `hours`',
      'Check hours\n===',
      'Check hours\n---',
    ]) {
      const html = renderToStaticMarkup(
        React.createElement(QuizMarkdown, { choice: true, children: markdown }),
      );
      assert.doesNotMatch(html, /<h[1-6]\b/);
      assert.match(html, /<p>/);
    }
    const html = renderToStaticMarkup(
      React.createElement(QuizMarkdown, {
        choice: true,
        children: '### **Check** `hours`',
      }),
    );
    assert.match(html, /<strong[^>]*>Check<\/strong>/);
    assert.match(html, /<code>hours<\/code>/);
    assert.match(render('## Explanation'), /<h2/);
  });
});

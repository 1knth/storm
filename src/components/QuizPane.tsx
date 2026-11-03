import {
  createContext,
  useContext,
  useCallback,
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import 'katex/dist/katex.min.css';
import {
  markdownMathRemarkPlugin,
  markdownMathRehypePlugin,
} from './Editor/markdownMath';
import { remarkSoftBreaks } from './Editor/markdownSoftBreaks';
import { remarkQuizCurrency } from './quizMarkdownCurrency';
import { remarkQuizLatexDelimiters } from './quizMarkdownMath';
import MermaidBlock from './Editor/MermaidBlock';
import type { Appearance } from '../appearance';
import { DEFAULT_APPEARANCE } from '../appearance';
import {
  getClipboardImages,
  getQuizAnswerFields,
  getQuizConfidenceLabel,
  getQuizComposerIntent,
  handleQuizComposerEnter,
  shouldClearSubmittedDraft,
  isCompleteQuestionAnswer,
  quizPiAttachCommand,
  quizCliInstructions,
} from './quizComposer';
import { FaListUl, FaPencil, FaTelegram, FaTrash } from 'react-icons/fa6';
import { FaPlus } from 'react-icons/fa';
import { FiStopCircle } from 'react-icons/fi';
import { IoChevronDown, IoChevronUp, IoClose } from 'react-icons/io5';
import { IoIosCheckmarkCircle, IoIosInformationCircle } from 'react-icons/io';
import { TbXboxXFilled } from 'react-icons/tb';
import { useToast } from './Toast';
import type {
  QuizDraft,
  QuizLearnerRequest,
  QuizLearning,
  QuizScope,
  QuizSession,
  QuizSessionSummary,
} from '../shared/quizProtocol';

type PublicQuizSession = Omit<QuizSession, 'agentToken'>;
type QuizContentDrafts = {
  currentQuestion: Pick<
    QuizDraft,
    'selectedChoiceId' | 'reasoningDraft' | 'matchesDraft' | 'textDraft'
  >;
  currentPrompt: Pick<
    NonNullable<QuizSession['currentPrompt']>,
    'selectedChoiceId' | 'detailDraft'
  >;
};
type QuizBridge = {
  listSessions(): Promise<QuizSessionSummary[]>;
  deleteSession(
    id: string,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  renameSession(
    id: string,
    name: string,
  ): Promise<
    { ok: true; value: PublicQuizSession } | { ok: false; error: string }
  >;
  createSession(
    scope?: QuizScope,
  ): Promise<
    { ok: true; value: PublicQuizSession } | { ok: false; error: string }
  >;
  getSnapshot(id: string): Promise<{ session: PublicQuizSession } | null>;
  request(
    request: QuizLearnerRequest,
  ): Promise<
    { ok: true; value: PublicQuizSession } | { ok: false; error: string }
  >;
  stopAgent(
    sessionId: string,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  addImage(
    sessionId: string,
    image: { mimeType: string; data: Uint8Array },
  ): Promise<
    | { ok: true; value: { id: string; mimeType: string; size: number } }
    | { ok: false; error: string }
  >;
  removeImage(sessionId: string, imageId: string): Promise<unknown>;
  saveDraft(
    id: string,
    revision: number,
    draft: QuizDraft,
  ): Promise<
    { ok: true; value: PublicQuizSession } | { ok: false; error: string }
  >;
};
declare global {
  interface Window {
    stormQuiz?: QuizBridge;
  }
}
const PICKER_KEY = 'storm.quiz.selectedSession';
type PendingImage = { id: string; mimeType: string; size: number; url: string };
type SentImage = PendingImage;

type QuizRevealHistory = { sessionId: string | null; ids: Set<string> };
type QuizRevealMessage = { id: string; role: string; kind?: string };

export function updateQuizRevealHistory(
  history: QuizRevealHistory,
  sessionId: string,
  messages: QuizRevealMessage[],
  opening = false,
): string[] {
  const ids = new Set(messages.map((message) => message.id));
  if (opening || history.sessionId !== sessionId) {
    history.sessionId = sessionId;
    history.ids = ids;
    return [];
  }
  const fresh = messages
    .filter(
      (message) =>
        !history.ids.has(message.id) &&
        message.role === 'agent' &&
        message.kind !== 'question',
    )
    .map((message) => message.id);
  history.sessionId = sessionId;
  history.ids = ids;
  return fresh;
}

const quizMarkdownRemarkPlugins = [
  markdownMathRemarkPlugin,
  remarkQuizLatexDelimiters,
  remarkQuizCurrency,
  remarkGfm,
  remarkSoftBreaks,
];
function rehypeQuizWordReveal() {
  return (tree: any) => {
    let index = 0;
    const visit = (node: any, parent?: any) => {
      const classes = node.properties?.className ?? [];
      const atomic =
        ['code', 'pre', 'img'].includes(node.tagName) ||
        classes.some((name: string) => /math|katex/i.test(name));
      if (atomic && parent && node.tagName !== 'svg') {
        const wrapper = {
          type: 'element',
          tagName: 'span',
          properties: {
            className: ['quiz-reveal-unit'],
            style: { '--quiz-word-index': index++ },
          },
          children: [node],
        };
        parent.children[parent.children.indexOf(node)] = wrapper;
        return;
      }
      if (node.type === 'text') {
        // Keep structural whitespace between table rows/cells as text. Wrapping
        // it in spans creates invalid table children that browsers move outside.
        if (
          !node.value.trim() &&
          ['table', 'thead', 'tbody', 'tfoot', 'tr'].includes(parent?.tagName)
        )
          return;
        const parts = node.value.split(/(\\s+)/);
        node.type = 'element';
        node.tagName = 'span';
        node.properties = {};
        node.children = parts.map((part: string) =>
          part.trim()
            ? {
                type: 'element',
                tagName: 'span',
                properties: {
                  className: ['quiz-reveal-word'],
                  style: { '--quiz-word-index': index++ },
                },
                children: [{ type: 'text', value: part }],
              }
            : { type: 'text', value: part },
        );
        return;
      }
      for (const child of node.children?.slice() ?? []) visit(child, node);
      if (node.tagName === 'li') {
        const firstIndex = (children: any[]): number | undefined => {
          for (const child of children) {
            const value = child.properties?.style?.['--quiz-word-index'];
            if (value !== undefined) return Number(value);
            const nested = firstIndex(child.children ?? []);
            if (nested !== undefined) return nested;
          }
          return undefined;
        };
        const markerIndex = firstIndex(node.children ?? []);
        if (markerIndex !== undefined) {
          node.properties ??= {};
          const isTask = (node.properties.className ?? []).includes(
            'task-list-item',
          );
          if (isTask) {
            const checkbox = (node.children ?? []).find(
              (child: any) =>
                child.tagName === 'input' &&
                child.properties?.type === 'checkbox',
            );
            if (checkbox) {
              checkbox.properties.className = [
                ...(checkbox.properties.className ?? []),
                'quiz-reveal-task-checkbox',
              ];
              checkbox.properties.style = {
                ...checkbox.properties.style,
                '--quiz-word-index': markerIndex,
              };
            }
          }
          node.properties.className = [
            ...(node.properties.className ?? []),
            'quiz-reveal-list-item',
          ];
          if (!isTask)
            node.children.unshift({
              type: 'element',
              tagName: 'span',
              properties: {
                className: ['quiz-reveal-marker'],
                style: { '--quiz-word-index': markerIndex },
                ariaHidden: 'true',
              },
              children: [],
            });
        }
      }
    };
    visit(tree);
  };
}
const quizMarkdownRehypePlugins = [markdownMathRehypePlugin];
export const QuizMarkdownAppearanceContext = createContext(DEFAULT_APPEARANCE);
function SafeQuizMarkdownLink({ href, children, ...props }: any) {
  if (typeof href !== 'string') return <span>{children}</span>;
  try {
    const url = new URL(href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return <span>{children}</span>;
    }
    return (
      <a {...props} href={url.href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  } catch {
    return <span>{children}</span>;
  }
}
function quizHeading(Heading: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') {
  return function QuizHeading({ children, ...props }: any) {
    const appearance = useContext(QuizMarkdownAppearanceContext);
    return (
      <Heading
        {...props}
        style={{ color: appearance.headings[Number(Heading[1]) - 1] }}
      >
        {children}
      </Heading>
    );
  };
}

// Choices are labels, so accidental Markdown headings should remain body text.
function QuizChoiceHeading({ children }: any) {
  return <p>{children}</p>;
}
const quizChoiceHeadingComponents = {
  h1: QuizChoiceHeading,
  h2: QuizChoiceHeading,
  h3: QuizChoiceHeading,
  h4: QuizChoiceHeading,
  h5: QuizChoiceHeading,
  h6: QuizChoiceHeading,
};

const quizMarkdownComponents = {
  a: SafeQuizMarkdownLink,
  table: ({ children, node: _node, ...props }: any) => (
    <div
      className="quiz-markdown-table-scroll"
      tabIndex={0}
      role="region"
      aria-label="Table"
    >
      <table {...props}>{children}</table>
    </div>
  ),
  h1: quizHeading('h1'),
  h2: quizHeading('h2'),
  h3: quizHeading('h3'),
  h4: quizHeading('h4'),
  h5: quizHeading('h5'),
  h6: quizHeading('h6'),
  strong: ({ children, node: _node, ...props }: any) => {
    const a = useContext(QuizMarkdownAppearanceContext);
    return (
      <strong {...props} style={{ color: a.previewBoldColor ?? undefined }}>
        {children}
      </strong>
    );
  },
  em: ({ children, node: _node, ...props }: any) => {
    const a = useContext(QuizMarkdownAppearanceContext);
    return (
      <em {...props} style={{ color: a.previewItalicColor ?? undefined }}>
        {children}
      </em>
    );
  },
  pre: ({ children, ...props }: any) => {
    const appearance = useContext(QuizMarkdownAppearanceContext);
    const child = Array.isArray(children) ? children[0] : children;
    if (child && typeof child === 'object' && 'props' in child) {
      const code = child.props as { className?: string; children?: unknown };
      if (code.className?.split(/\\s+/).includes('language-mermaid'))
        return (
          <MermaidBlock
            source={String(code.children ?? '').replace(/\\n$/, '')}
            appearance={appearance}
          />
        );
    }
    return <pre {...props}>{children}</pre>;
  },
};

export function mergeQuizSessionDrafts<T extends PublicQuizSession>(
  incoming: T,
  current: T | null,
): T {
  if (!current || current.id !== incoming.id) return incoming;
  if (current.revision > incoming.revision) return current;
  const question = incoming.currentQuestion;
  const currentQuestion = current.currentQuestion;
  const prompt = incoming.currentPrompt;
  const currentPrompt = current.currentPrompt;
  return {
    ...incoming,
    freeChatDraft: current.freeChatDraft,
    currentQuestion:
      question &&
      question.status === 'open' &&
      currentQuestion?.id === question.id &&
      currentQuestion.status === 'open'
        ? {
            ...question,
            selectedChoiceId: currentQuestion.selectedChoiceId,
            reasoningDraft: currentQuestion.reasoningDraft,
            matchesDraft: currentQuestion.matchesDraft,
            textDraft: currentQuestion.textDraft,
          }
        : question,
    currentPrompt:
      prompt && currentPrompt?.id === prompt.id
        ? {
            ...prompt,
            selectedChoiceId: currentPrompt.selectedChoiceId,
            detailDraft: currentPrompt.detailDraft,
          }
        : prompt,
  };
}

export function getMatchingItemLabel(side: 'left' | 'right', index: number) {
  return side === 'left' ? String.fromCharCode(65 + index) : `${index + 1}.`;
}

export function QuizThinkingIndicator({
  activity,
}: {
  activity: 'thinking' | 'drafting' | 'waiting';
}) {
  return (
    <div
      className="mb-4 flex items-center gap-2 text-left text-xs text-white/65"
      role="status"
      aria-live="polite"
    >
      <span className="quiz-activity-spinner" aria-hidden="true" />
      {activity === 'thinking'
        ? 'Thinking…'
        : activity === 'drafting'
          ? 'Drafting…'
          : 'Waiting for agent…'}
    </div>
  );
}

export function getQuizActivityIndicator(
  session:
    | Pick<QuizSession, 'status' | 'awaitingAgent' | 'activity'>
    | null
    | undefined,
): 'thinking' | 'drafting' | 'waiting' | undefined {
  if (!session || session.status !== 'connected') return undefined;
  if (
    session.activity?.state === 'thinking' ||
    session.activity?.state === 'drafting'
  )
    return session.activity.state;
  return session.awaitingAgent ? 'waiting' : undefined;
}

export function scrollQuizTranscriptToBottom(
  pane: Pick<HTMLDivElement, 'scrollHeight' | 'scrollTop'>,
) {
  pane.scrollTop = pane.scrollHeight;
}

export function getQuizComposerActions(
  questionStatus: 'open' | 'answered' | 'feedback' | undefined,
  connected: boolean,
) {
  return {
    showContinue: questionStatus === 'feedback',
    showDisconnectedStatus: !connected && questionStatus !== 'feedback',
  };
}

export function QuizVerdict({
  verdict,
  answerLabel,
  confidence,
}: {
  verdict?: 'correct' | 'incorrect' | 'partial';
  answerLabel?: string;
  confidence?: number;
}) {
  if (!verdict && confidence === undefined) return null;
  const label =
    verdict === 'correct'
      ? 'Correct'
      : verdict === 'incorrect'
        ? 'Incorrect'
        : verdict === 'partial'
          ? 'Partially correct'
          : undefined;
  return (
    <div
      className={`quiz-verdict ${verdict ? `quiz-verdict--${verdict}` : ''} mb-2 flex flex-wrap items-center gap-2`}
      aria-label={label}
    >
      {verdict === 'incorrect' ? (
        <TbXboxXFilled aria-hidden="true" />
      ) : verdict ? (
        <IoIosCheckmarkCircle aria-hidden="true" />
      ) : null}
      {label && (
        <span>
          {label}
          {answerLabel ? ` · Selected: ${answerLabel}` : ''}
        </span>
      )}
      {confidence !== undefined && (
        <span className="text-xs font-normal text-white/50">
          Confidence {confidence}%
        </span>
      )}
    </div>
  );
}

export function QuizAnswerActions({
  questionId,
  confidence,
  answerComplete,
  connected,
  busy,
  onConfidenceChange,
  onSkip,
  onSubmit,
}: {
  questionId: string;
  confidence: number | null;
  answerComplete: boolean;
  connected: boolean;
  busy: boolean;
  onConfidenceChange: (value: number) => void;
  onSkip: () => void;
  onSubmit: () => void;
}) {
  const confidenceId = `quiz-confidence-${questionId}`;
  const confidenceText =
    confidence === null
      ? 'Not rated'
      : `${confidence}% · ${getQuizConfidenceLabel(confidence)}`;
  const disabled = !connected || busy;
  const missingAnswer = !answerComplete || confidence === null;
  return (
    <div className="quiz-answer-actions mt-3 border-t border-white/10 pt-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
        <label htmlFor={confidenceId} className="text-white/70">
          How confident are you?
        </label>
        <output htmlFor={confidenceId} className="text-white/50">
          {confidenceText}
        </output>
      </div>
      <input
        id={confidenceId}
        type="range"
        min={0}
        max={100}
        step={5}
        // The neutral thumb position is visual only; null remains unrated until interaction.
        value={confidence ?? 50}
        aria-valuetext={confidenceText}
        disabled={disabled}
        className={`quiz-confidence-slider my-2 block w-full cursor-pointer rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:cursor-not-allowed ${confidence === null ? 'quiz-confidence-slider--unrated' : ''}`}
        onChange={(event) =>
          onConfidenceChange(event.currentTarget.valueAsNumber)
        }
        onPointerUp={(event) => {
          if (!disabled) onConfidenceChange(event.currentTarget.valueAsNumber);
        }}
        onKeyUp={(event) => {
          if (
            !disabled &&
            [
              'ArrowLeft',
              'ArrowRight',
              'ArrowUp',
              'ArrowDown',
              'Home',
              'End',
              'PageUp',
              'PageDown',
            ].includes(event.key)
          )
            onConfidenceChange(event.currentTarget.valueAsNumber);
        }}
      />
      {missingAnswer && (
        <p role="status" className="mb-2 text-xs text-white/45">
          {answerComplete
            ? 'Rate your confidence to submit.'
            : confidence === null
              ? 'Complete your answer and rate your confidence to submit.'
              : 'Complete your answer to submit.'}
        </p>
      )}
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          disabled={disabled}
          title="Skip this question without a grade"
          className="cursor-pointer rounded px-2 py-1.5 text-xs text-white/50 hover:bg-white/5 hover:text-white/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white disabled:cursor-not-allowed disabled:opacity-40"
          onClick={onSkip}
        >
          Skip question
        </button>
        <button
          type="button"
          disabled={disabled || missingAnswer}
          className="quiz-action-button shrink-0 cursor-pointer rounded px-3.5 py-1.5 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:cursor-not-allowed"
          onClick={onSubmit}
        >
          Submit answer
        </button>
      </div>
    </div>
  );
}

export function QuizLearningTag({ learning }: { learning?: QuizLearning }) {
  if (!learning) return null;
  const level = {
    recall: 'Recall',
    explain: 'Explain',
    apply: 'Apply',
    transfer: 'Transfer',
  }[learning.level];
  const support = {
    independent: '',
    hinted: ' · with hints',
    worked: ' · worked example',
  }[learning.support];
  return (
    <p
      className="mb-2 text-xs text-white/45"
      title={learning.concepts.join(', ')}
    >
      {level}
      {support}
    </p>
  );
}

export const QuizMarkdown = memo(function QuizMarkdown({
  children,
  reveal = false,
  choice = false,
  appearance,
}: {
  children: string;
  reveal?: boolean;
  choice?: boolean;
  appearance?: Appearance;
}) {
  const inheritedAppearance = useContext(QuizMarkdownAppearanceContext);
  const configuredAppearance = appearance ?? inheritedAppearance;
  return (
    <QuizMarkdownAppearanceContext.Provider value={configuredAppearance}>
      <div
        className="quiz-agent-markdown"
        style={
          {
            '--preview-bold-color':
              configuredAppearance.previewBoldColor ?? undefined,
            '--preview-italic-color':
              configuredAppearance.previewItalicColor ?? undefined,
            '--preview-list-marker-color':
              configuredAppearance.listMarkerColor ?? undefined,
          } as React.CSSProperties
        }
      >
        <ReactMarkdown
          remarkPlugins={quizMarkdownRemarkPlugins}
          rehypePlugins={
            reveal
              ? [...quizMarkdownRehypePlugins, rehypeQuizWordReveal]
              : quizMarkdownRehypePlugins
          }
          components={
            choice
              ? { ...quizMarkdownComponents, ...quizChoiceHeadingComponents }
              : quizMarkdownComponents
          }
        >
          {children}
        </ReactMarkdown>
      </div>
    </QuizMarkdownAppearanceContext.Provider>
  );
});

export default function QuizPane({
  visible,
  onClose,
  appearance,
}: {
  vaultId: string | null;
  vaultName: string;
  notePath: string | null;
  appearance: Appearance;
  visible: boolean;
  onClose: () => void;
}) {
  const bridge = window.stormQuiz;
  const { notifyError, notifySuccess } = useToast();
  const [sessions, setSessions] = useState<QuizSessionSummary[]>([]);
  const [session, setSession] = useState<PublicQuizSession | null>(null);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [pendingImages, setPendingImages] = useState<
    Record<string, PendingImage[]>
  >({});
  const imagesRef = useRef(pendingImages);
  imagesRef.current = pendingImages;
  const [sentImages, setSentImages] = useState<Record<string, SentImage[]>>({});
  const sentImagesRef = useRef(sentImages);
  sentImagesRef.current = sentImages;
  const deletedSessions = useRef(new Set<string>());
  const [showSessionList, setShowSessionList] = useState(true);
  const [sessionSearch, setSessionSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [confidenceRating, setConfidenceRating] = useState<{
    questionId: string | null;
    value: number | null;
  }>({ questionId: null, value: null });
  const [stopping, setStopping] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [sessionName, setSessionName] = useState('');
  const [qaExpanded, setQaExpanded] = useState(true);
  const [revealingContentId, setRevealingContentId] = useState<string | null>(
    null,
  );
  const revealHistory = useRef<{ sessionId: string | null; ids: Set<string> }>({
    sessionId: null,
    ids: new Set(),
  });
  const [revealingMessageIds, setRevealingMessageIds] = useState<Set<string>>(
    new Set(),
  );
  const transcriptRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLFormElement>(null);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const [composerSpacerHeight, setComposerSpacerHeight] = useState(0);
  const questionIdRef = useRef<string | null>(null);
  const sessionRef = useRef(session);
  const openGeneration = useRef(0);
  const draftRef = useRef(draft);
  const busyRef = useRef(false);
  const saveTimer = useRef<number | undefined>(undefined);
  const saveQueue = useRef(Promise.resolve());
  const draftRevision = useRef<number | null>(null);
  sessionRef.current = session;
  useEffect(() => {
    setConfidenceRating({
      questionId: session?.currentQuestion?.id ?? null,
      value: null,
    });
  }, [session?.id, session?.currentQuestion?.id]);
  useEffect(
    () => () => {
      for (const [sessionId, images] of Object.entries(imagesRef.current)) {
        for (const image of images) {
          URL.revokeObjectURL(image.url);
          void bridge?.removeImage(sessionId, image.id).catch(() => undefined);
        }
      }
      for (const images of Object.values(sentImagesRef.current))
        for (const image of images) URL.revokeObjectURL(image.url);
    },
    [bridge],
  );
  useLayoutEffect(() => {
    if (!session) return;
    const freshIds = updateQuizRevealHistory(
      revealHistory.current,
      session.id,
      session.transcript,
    );
    if (
      revealHistory.current.sessionId !== session.id ||
      freshIds.length === 0
    ) {
      setRevealingMessageIds(new Set());
      return;
    }
    const reducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    if (!reducedMotion) {
      setRevealingMessageIds((current) => new Set([...current, ...freshIds]));
    }
  }, [session]);
  draftRef.current = draft;
  busyRef.current = busy;

  useLayoutEffect(() => {
    const textarea = messageInputRef.current;
    if (!textarea) return;

    const resize = () => {
      // Reset first so deleting text and narrower/wider wraps shrink as well as grow.
      textarea.style.height = 'auto';
      const styles = window.getComputedStyle(textarea);
      const maxHeight = Number.parseFloat(styles.maxHeight);
      const nextHeight = Number.isFinite(maxHeight)
        ? Math.min(textarea.scrollHeight, maxHeight)
        : textarea.scrollHeight;
      textarea.style.height = `${nextHeight}px`;
      textarea.style.overflowY =
        textarea.scrollHeight > nextHeight ? 'auto' : 'hidden';
    };

    resize();
    let previousWidth = textarea.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const width = textarea.getBoundingClientRect().width;
      if (width === previousWidth) return;
      previousWidth = width;
      resize();
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [draft]);

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    const composer = composerRef.current;
    if (!transcript || !composer || showSessionList || !visible) return;

    const measure = () => {
      const height = Math.ceil(composer.getBoundingClientRect().height) + 24;
      setComposerSpacerHeight((current) =>
        current === height ? current : height,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(composer);
    return () => observer.disconnect();
  }, [
    visible,
    showSessionList,
    session?.id,
    qaExpanded,
    session?.currentQuestion,
    draft,
    pendingImages,
    sentImages,
  ]);

  const latestMessageId = session?.transcript.at(-1)?.id;
  const activityState = session?.activity?.state;
  const visibleActivity = getQuizActivityIndicator(session);
  useEffect(() => {
    const pane = transcriptRef.current;
    if (!pane || showSessionList || !visible) return;
    scrollQuizTranscriptToBottom(pane);
  }, [
    session?.id,
    latestMessageId,
    activityState,
    session?.awaitingAgent,
    composerSpacerHeight,
    showSessionList,
    visible,
  ]);
  const copyQuizInstructions = useCallback(
    async (text: string, copied: string) => {
      try {
        await navigator.clipboard.writeText(text);
        notifySuccess(copied);
      } catch (error) {
        notifyError(
          error instanceof Error && error.message
            ? `Could not copy instructions: ${error.message}`
            : 'Could not copy instructions.',
        );
      }
    },
    [notifyError, notifySuccess],
  );
  const persistDraft = useCallback(
    (id: string, immediate = false) => {
      if (!bridge) return;
      window.clearTimeout(saveTimer.current);
      const latest = sessionRef.current;
      if (!latest || latest.id !== id) return;
      const question = latest.currentQuestion;
      const prompt = latest.currentPrompt;
      const value: QuizDraft = {
        questionId: question?.id ?? null,
        selectedChoiceId: question?.selectedChoiceId ?? null,
        reasoningDraft: question?.reasoningDraft ?? '',
        freeChatDraft: draftRef.current,
        matchesDraft: question?.matchesDraft,
        textDraft: question?.textDraft,
        promptId: prompt?.id,
        selectedPromptChoiceId: prompt?.selectedChoiceId,
        promptDetailDraft: prompt?.detailDraft,
      };
      const save = () => {
        saveQueue.current = saveQueue.current
          .then(async () => {
            const send = (revision: number) =>
              bridge.saveDraft(id, revision, value);
            let result = await send(draftRevision.current ?? latest.revision);
            if (!result.ok && result.error === 'stale-revision') {
              const snapshot = await bridge.getSnapshot(id);
              if (!snapshot) return;
              draftRevision.current = snapshot.session.revision;
              result = await send(snapshot.session.revision);
            }
            if (result.ok && sessionRef.current?.id === id) {
              draftRevision.current = Math.max(
                draftRevision.current ?? 0,
                result.value.revision,
              );
              setSession((current) => {
                if (current?.id !== id) return current;
                return mergeQuizSessionDrafts(result.value, current);
              });
            }
          })
          .catch(() => undefined);
      };
      if (immediate) save();
      else saveTimer.current = window.setTimeout(save, 350);
    },
    [bridge],
  );

  function updateContentDraft<K extends keyof QuizContentDrafts>(
    field: K,
    patch: Partial<QuizContentDrafts[K]>,
  ) {
    if (!session?.[field]) return;
    const next = { ...session, [field]: { ...session[field], ...patch } };
    // Draft persistence reads the ref before React commits the state update.
    sessionRef.current = next;
    setSession(next);
    persistDraft(session.id);
  }

  const restoreSession = useCallback((value: PublicQuizSession | null) => {
    // Hydrate reveal history before React can commit the opened snapshot. Every
    // message present in this snapshot is history, including arrivals while away.
    if (value) {
      updateQuizRevealHistory(
        revealHistory.current,
        value.id,
        value.transcript,
        true,
      );
      setRevealingMessageIds(new Set());
    }
    setRevealingContentId(null);
    setSession(value);
    const questionId = value?.currentQuestion?.id ?? null;
    if (questionId !== questionIdRef.current) setQaExpanded(true);
    questionIdRef.current = questionId;
    setDraft(value?.freeChatDraft ?? '');
    draftRevision.current = value?.revision ?? null;
  }, []);
  const refresh = useCallback(async () => {
    if (!bridge) return;
    const next = await bridge.listSessions();
    setSessions(next);
    const id = window.localStorage.getItem(PICKER_KEY);
    const current = sessionRef.current;
    if (current) {
      if (showSessionList || busyRef.current) return;
      const generation = openGeneration.current;
      const snapshot = await bridge.getSnapshot(current.id);
      const latest = sessionRef.current;
      const updated = snapshot?.session;
      if (
        updated &&
        latest?.id === current.id &&
        generation === openGeneration.current &&
        !busyRef.current &&
        updated.revision >= latest.revision
      ) {
        const newContentId =
          updated.currentQuestion?.id !== latest.currentQuestion?.id
            ? updated.currentQuestion?.id
            : updated.currentPrompt?.id !== latest.currentPrompt?.id
              ? updated.currentPrompt?.id
              : undefined;
        if (visible && newContentId) setRevealingContentId(newContentId);
        setSession(mergeQuizSessionDrafts(updated, latest));
      }
    } else if (!showSessionList && id && next.some((item) => item.id === id)) {
      const generation = openGeneration.current;
      try {
        const snapshot = await bridge.getSnapshot(id);
        if (
          snapshot &&
          !sessionRef.current &&
          generation === openGeneration.current
        )
          restoreSession(snapshot.session);
      } catch {
        /* keep the picker usable during transient service failures */
      }
    }
  }, [bridge, restoreSession, showSessionList, visible]);
  useEffect(() => {
    if (!bridge) return;
    let live = true;
    const load = async () => {
      try {
        const list = await bridge.listSessions();
        if (!live) return;
        setSessions(list);
        // Startup lands in the picker. Keep the remembered ID intact so the
        // user can return to that session, but never open it automatically.
      } catch {
        if (live) setError('Could not load quiz sessions.');
      }
    };
    void load();
    let timer: number | undefined;
    const poll = async () => {
      try {
        await refresh();
      } catch {
        if (live) setError('Could not refresh quiz sessions.');
      } finally {
        if (live) timer = window.setTimeout(poll, 1000);
      }
    };
    if (visible) timer = window.setTimeout(poll, 1000);
    const onStorage = (event: StorageEvent) => {
      if (event.key === PICKER_KEY) {
        if (event.newValue) void openSession(event.newValue);
        else setSession(null);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => {
      live = false;
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener('storage', onStorage);
    };
  }, [bridge, refresh, visible]);
  async function openSession(id: string) {
    if (!bridge) return;
    const generation = ++openGeneration.current;
    try {
      if (sessionRef.current) persistDraft(sessionRef.current.id, true);
      window.clearTimeout(saveTimer.current);
      const snapshot = await bridge.getSnapshot(id);
      if (generation !== openGeneration.current) return;
      restoreSession(snapshot?.session ?? null);
      if (snapshot) {
        window.localStorage.setItem(PICKER_KEY, id);
      }
    } catch {
      setError('Could not open session.');
    }
  }
  const update = async (action: () => ReturnType<QuizBridge['request']>) => {
    setBusy(true);
    setError('');
    try {
      const actionSessionId = sessionRef.current?.id;
      const result = await action();
      if (!result.ok) {
        setError(`Quiz action failed: ${result.error}`);
        return;
      }
      if (sessionRef.current?.id !== actionSessionId) return;
      const questionId = result.value.currentQuestion?.id ?? null;
      const previous = sessionRef.current;
      const newContentId =
        result.value.currentQuestion?.id !== previous?.currentQuestion?.id
          ? result.value.currentQuestion?.id
          : result.value.currentPrompt?.id !== previous?.currentPrompt?.id
            ? result.value.currentPrompt?.id
            : undefined;
      if (visible && newContentId) setRevealingContentId(newContentId);
      if (questionId !== questionIdRef.current) setQaExpanded(true);
      questionIdRef.current = questionId;
      const merged = mergeQuizSessionDrafts(result.value, previous);
      setSession(merged);
      sessionRef.current = merged;
      setSessions(await bridge!.listSessions());
    } catch {
      setError('Could not reach the quiz service.');
    } finally {
      setBusy(false);
    }
  };
  const stopAgent = async (id: string) => {
    if (!bridge) return;
    setStopping(true);
    setError('');
    try {
      const result = await bridge.stopAgent(id);
      if (!result.ok) {
        setError(`Could not stop agent: ${result.error}`);
        return;
      }
      await refresh();
      setError('Agent stopped. Session and transcript preserved.');
    } catch {
      setError('Could not reach the quiz service to stop the agent.');
    } finally {
      setStopping(false);
    }
  };
  const deleteSession = async (id: string) => {
    if (!bridge || deleting) return;
    setDeleting(id);
    setError('');
    try {
      const result = await bridge.deleteSession(id);
      if (!result.ok) {
        setError(`Could not delete session: ${result.error}`);
        return;
      }
      deletedSessions.current.add(id);
      for (const image of imagesRef.current[id] ?? []) {
        URL.revokeObjectURL(image.url);
        void bridge.removeImage(id, image.id).catch(() => undefined);
      }
      for (const image of sentImagesRef.current[id] ?? [])
        URL.revokeObjectURL(image.url);
      setPendingImages((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setSentImages((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      if (sessionRef.current?.id === id) {
        window.clearTimeout(saveTimer.current);
        draftRevision.current = null;
        restoreSession(null);
        window.localStorage.removeItem(PICKER_KEY);
      }
      setSessions((items) => items.filter((item) => item.id !== id));
      setConfirmDelete(null);
    } catch {
      setError('Could not reach the quiz service to delete the session.');
    } finally {
      setDeleting(null);
    }
  };
  const connected = session?.status === 'connected';
  const question = session?.currentQuestion;
  const questionKind = question?.kind ?? 'multiple-choice';
  const answerComplete =
    !!question &&
    question.status === 'open' &&
    isCompleteQuestionAnswer(questionKind, {
      choiceId: question.selectedChoiceId,
      leftItems: question.leftItems?.map((item) => item.id),
      matches: question.matchesDraft,
      text: question.textDraft,
    });
  const confidence =
    confidenceRating.questionId === question?.id
      ? confidenceRating.value
      : null;
  const answerFields = question
    ? getQuizAnswerFields(question, confidence)
    : null;
  const canSubmitAnswer = connected && !busy && answerFields !== null;
  const prompt = session?.currentPrompt;
  const composerActions = getQuizComposerActions(question?.status, !!connected);
  const canRespondPrompt = !!prompt?.selectedChoiceId;
  const sessionImages = session ? (pendingImages[session.id] ?? []) : [];
  const composerIntent = getQuizComposerIntent(
    draft,
    sessionImages.length,
    canRespondPrompt,
  );
  const hasChatMessage = composerIntent === 'message';
  const sendComposer = () => {
    if (composerIntent) send(composerIntent);
  };
  const send = (
    type: 'answer' | 'message' | 'continue' | 'prompt' | 'skip',
  ) => {
    if (!session || !bridge || !connected || busy) return;
    const base = {
      sessionId: session.id,
      expectedRevision: session.revision,
      idempotencyKey: crypto.randomUUID(),
    };
    if (type === 'continue')
      void update(() => bridge.request({ ...base, type }));
    else if (type === 'skip' && question)
      void update(() =>
        bridge.request({ ...base, type, questionId: question.id }),
      );
    else if (type === 'prompt' && session.currentPrompt?.selectedChoiceId) {
      const p = session.currentPrompt;
      void update(() =>
        bridge.request({
          ...base,
          type: 'respond-prompt',
          promptId: p.id,
          choiceId: p.selectedChoiceId!,
          ...(p.detailDraft?.trim() ? { detail: p.detailDraft.trim() } : {}),
        }),
      );
    } else if (type === 'message' && (draft.trim() || sessionImages.length)) {
      const submittedDraft = draft;
      const sent = submittedDraft.trim();
      const images = sessionImages;
      void update(async () => {
        const result = await bridge.request({
          ...base,
          type,
          text: sent,
          ...(images.length
            ? { attachments: images.map((image) => image.id) }
            : {}),
        });
        if (result.ok && !deletedSessions.current.has(session.id)) {
          if (shouldClearSubmittedDraft(draftRef.current, submittedDraft)) {
            draftRef.current = '';
            setDraft('');
            const current = sessionRef.current;
            if (current?.id === session.id) {
              const cleared = { ...current, freeChatDraft: '' };
              sessionRef.current = cleared;
              setSession((latest) =>
                latest?.id === session.id
                  ? { ...latest, freeChatDraft: '' }
                  : latest,
              );
            }
          }
          setSentImages((current) => ({
            ...current,
            [session.id]: [...(current[session.id] ?? []), ...images],
          }));
          setPendingImages((current) => ({
            ...current,
            [session.id]: (current[session.id] ?? []).filter(
              (image) => !images.includes(image),
            ),
          }));
        }
        return result;
      });
    } else if (type === 'answer' && canSubmitAnswer && answerFields) {
      void update(() =>
        bridge.request({
          ...base,
          type,
          ...answerFields,
        }),
      );
    }
  };
  return (
    <QuizMarkdownAppearanceContext.Provider value={appearance}>
      <section
        className="quiz-pane-surface flex min-h-0 min-w-0 flex-1 flex-col border-l border-white/10 text-white"
        aria-label="Quiz"
      >
        <header className="flex flex-col border-b border-white/10 px-4 py-2">
          <div className="flex items-center justify-between">
            <div className="flex min-w-0 items-center gap-2">
              {session && !showSessionList ? (
                renaming ? (
                  <input
                    autoFocus
                    aria-label="Session name"
                    className="min-w-0 border-b border-white/30 bg-transparent text-sm text-white outline-none"
                    value={sessionName}
                    onChange={(event) => setSessionName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') setRenaming(false);
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        const name = sessionName.trim();
                        if (!name || !bridge) return;
                        void bridge
                          .renameSession(session.id, name)
                          .then((result) => {
                            if (result.ok) {
                              setSession(result.value);
                              setSessions((items) =>
                                items.map((item) =>
                                  item.id === session.id ? result.value : item,
                                ),
                              );
                              setRenaming(false);
                            } else
                              setError(
                                `Could not rename session: ${result.error}`,
                              );
                          })
                          .catch(() => setError('Could not rename session.'));
                      }
                    }}
                    onBlur={() => {
                      if (renaming) setRenaming(false);
                    }}
                  />
                ) : (
                  <>
                    <strong className="truncate">
                      {session.name || 'New session'}
                    </strong>
                    <button
                      type="button"
                      aria-label="Rename session"
                      title="Rename session"
                      className="rounded p-1 text-white/40 hover:text-white/80"
                      onClick={() => {
                        setSessionName(session.name || '');
                        setRenaming(true);
                      }}
                    >
                      <FaPencil aria-hidden="true" size={12} />
                    </button>
                    <button
                      type="button"
                      aria-label="Copy Pi attach command"
                      title="Copy Pi attach command"
                      className="inline-flex min-w-0 cursor-pointer items-center gap-1 rounded-md bg-white/10 px-1.5 py-0.5 text-left text-sm text-white/50 hover:text-white/80 focus-visible:outline focus-visible:outline-1 focus-visible:outline-white/70"
                      onClick={() =>
                        copyQuizInstructions(
                          quizPiAttachCommand(session.id),
                          'Copied attach command',
                        )
                      }
                    >
                      <span className="group relative inline-flex h-5 w-5 shrink-0 items-center justify-center text-white/45 hover:text-white/80">
                        <IoIosInformationCircle aria-hidden="true" size={17} />
                        <span
                          id="quiz-instructions-help"
                          role="tooltip"
                          className="pointer-events-none absolute left-0 top-full z-50 mt-2 hidden w-max max-w-[min(22rem,calc(100vw-2rem))] whitespace-normal rounded-xl border border-white/15 bg-[#22252a]/95 p-3 text-xs font-normal leading-relaxed text-white/90 shadow-xl backdrop-blur-md group-hover:block"
                        >
                          The session and transcript are preserved. In Pi with
                          the Storm quiz extension loaded, paste this command to
                          start or resume the quiz; the extension then sends the
                          snapshot and full instructions. Agents without the
                          extension need the CLI instructions instead.
                        </span>
                      </span>
                      <span className="quiz-instructions-label truncate">
                        Pi command
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label="Copy CLI agent instructions"
                      title="Copy CLI agent instructions"
                      className="inline-flex min-w-0 cursor-pointer items-center gap-1 rounded-md bg-white/10 px-1.5 py-0.5 text-left text-sm text-white/50 hover:text-white/80 focus-visible:outline focus-visible:outline-1 focus-visible:outline-white/70"
                      onClick={() =>
                        copyQuizInstructions(
                          quizCliInstructions(session.id, !!session.scope),
                          'Copied instructions',
                        )
                      }
                    >
                      <span className="quiz-instructions-label truncate">
                        CLI
                      </span>
                    </button>
                  </>
                )
              ) : (
                <strong>{showSessionList ? 'Sessions' : 'Quiz'}</strong>
              )}
            </div>
            <div className="flex items-center gap-1">
              {showSessionList && (
                <button
                  type="button"
                  aria-label="Create new session"
                  title="Create new session"
                  className="rounded p-2 text-white/70 hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
                  onClick={() => {
                    if (sessionRef.current)
                      persistDraft(sessionRef.current.id, true);
                    if (!bridge || busy) return;
                    setShowSessionList(false);
                    setError('');
                    setBusy(true);
                    void bridge
                      .createSession()
                      .then((result) => {
                        if (!result.ok) {
                          setError(`Quiz action failed: ${result.error}`);
                          return;
                        }
                        restoreSession(result.value);
                        window.localStorage.setItem(
                          PICKER_KEY,
                          result.value.id,
                        );
                      })
                      .catch(() =>
                        setError('Could not reach the quiz service.'),
                      )
                      .finally(() => setBusy(false));
                  }}
                >
                  <FaPlus aria-hidden="true" size={14} />
                </button>
              )}
              <button
                type="button"
                aria-label="Show quiz sessions"
                title="Show quiz sessions"
                className="rounded p-2 text-white/70 hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
                onClick={() => {
                  if (showSessionList) {
                    if (sessionRef.current) setShowSessionList(false);
                  } else {
                    if (sessionRef.current)
                      persistDraft(sessionRef.current.id, true);
                    setShowSessionList(true);
                  }
                }}
                aria-pressed={showSessionList}
              >
                <FaListUl aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label="Close Quiz"
                title="Close Quiz"
                className="rounded p-2 text-white/70 hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
                onClick={onClose}
              >
                <IoClose aria-hidden="true" size={20} />
              </button>
            </div>
          </div>
          {session && !showSessionList && (
            <div className="flex items-center gap-2 pt-1 pl-1">
              <span
                role="img"
                aria-label={`Agent ${session.status === 'connected' ? 'Connected' : 'Disconnected'}`}
                title={`Agent ${session.status === 'connected' ? 'Connected' : 'Disconnected'}`}
                className={`h-2 w-2 shrink-0 rounded-full ${
                  session.status === 'connected'
                    ? 'bg-emerald-400'
                    : 'bg-white/30'
                }`}
              />
              <span
                className={`shrink-0 text-xs ${
                  session.status === 'connected'
                    ? 'text-emerald-400'
                    : 'text-white/50'
                }`}
              >
                {session.status === 'connected' ? 'Connected' : 'Disconnected'}
              </span>
              {session.status === 'connected' && (
                <button
                  type="button"
                  disabled={stopping}
                  aria-label="Stop quiz agent"
                  title="Stop quiz agent"
                  aria-busy={stopping}
                  className="ml-2 inline-flex items-center gap-1 text-xs text-red-400 transition-colors hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={() => void stopAgent(session.id)}
                >
                  <FiStopCircle size={12} aria-hidden="true" />
                  {stopping ? 'Stopping…' : 'Stop'}
                </button>
              )}
            </div>
          )}
        </header>
        {!bridge ? (
          <div className="m-auto max-w-md p-6 text-center text-sm text-white/70">
            Quiz sessions are waiting for the quiz bridge to be connected. No AI
            runs inside Storm; attach an external agent using the session CLI.
          </div>
        ) : (
          <>
            {session && !showSessionList ? (
              <>
                <div className="quiz-transcript-pane relative flex min-h-0 flex-1 flex-col overflow-hidden">
                  <div
                    ref={transcriptRef}
                    className="min-h-[4rem] flex-1 overflow-y-auto px-4 pt-4"
                  >
                    {session.transcript.map((m, index) => {
                      const previousQuestion = [...session.transcript]
                        .slice(0, index)
                        .reverse()
                        .find(
                          (entry) =>
                            entry.kind === 'question' && entry.question,
                        );
                      const legacyAnswer =
                        m.role === 'learner' &&
                        previousQuestion?.question?.choices.some((choice) => {
                          const prefix = `Answer: ${choice.text}`;
                          return (
                            m.text === prefix ||
                            m.text.startsWith(`${prefix}\nReasoning: `)
                          );
                        });
                      const displayedText =
                        m.kind === 'answer'
                          ? m.text
                          : legacyAnswer
                            ? m.text.replace(/^Answer: /, '')
                            : m.text;
                      return (
                        <article
                          key={m.id}
                          className={`quiz-transcript-message mb-4 flex flex-col ${m.role === 'learner' ? 'items-end text-right' : 'quiz-transcript-message--agent items-start text-left'}`}
                        >
                          {m.role !== 'learner' && (
                            <b className="mb-1 text-xs font-bold uppercase tracking-wide text-white/60">
                              Agent
                            </b>
                          )}
                          {m.kind === 'question' && m.question ? (
                            <div
                              key={m.question.id}
                              className={`${revealingContentId === m.question.id ? 'quiz-new-question' : ''} w-full rounded-xl border border-white/10 bg-white/[0.04] p-3 text-left`}
                            >
                              <QuizLearningTag learning={m.question.learning} />
                              <QuizVerdict
                                verdict={m.question.verdict}
                                answerLabel={
                                  m.question.answerLabel ??
                                  m.question.chosenChoiceText
                                }
                                confidence={m.question.confidence}
                              />
                              <div className="quiz-agent-markdown">
                                <QuizMarkdown>{m.question.prompt}</QuizMarkdown>
                              </div>
                              {(m.question.kind ?? 'multiple-choice') ===
                                'multiple-choice' &&
                                m.question.choices.length > 0 && (
                                  <ol className="mt-3 list-[upper-alpha] space-y-2 pl-6 text-[0.95rem] leading-relaxed marker:font-semibold marker:text-white/70">
                                    {m.question.choices.map((choice) => (
                                      <li key={choice.id} className="pl-1">
                                        <QuizMarkdown choice>
                                          {choice.text}
                                        </QuizMarkdown>
                                      </li>
                                    ))}
                                  </ol>
                                )}
                              {m.question.kind === 'matching' && (
                                <div className="mt-3 grid min-w-0 grid-cols-1 gap-4 text-sm">
                                  <div>
                                    <h4 className="mb-1 font-semibold text-white/70">
                                      Items
                                    </h4>
                                    <ul className="list-disc space-y-1 pl-5">
                                      {(m.question.leftItems ?? []).map(
                                        (item, index) => (
                                          <li key={item.id}>
                                            <span className="font-semibold text-white/70">
                                              {getMatchingItemLabel(
                                                'left',
                                                index,
                                              )}{' '}
                                            </span>
                                            <QuizMarkdown choice>
                                              {item.text}
                                            </QuizMarkdown>
                                          </li>
                                        ),
                                      )}
                                    </ul>
                                  </div>
                                  <div>
                                    <h4 className="mb-1 font-semibold text-white/70">
                                      Match with
                                    </h4>
                                    <ul className="list-disc space-y-1 pl-5">
                                      {(m.question.rightItems ?? []).map(
                                        (item, index) => (
                                          <li key={item.id}>
                                            <span className="font-semibold text-white/70">
                                              {getMatchingItemLabel(
                                                'right',
                                                index,
                                              )}{' '}
                                            </span>
                                            <QuizMarkdown choice>
                                              {item.text}
                                            </QuizMarkdown>
                                          </li>
                                        ),
                                      )}
                                    </ul>
                                  </div>
                                </div>
                              )}
                            </div>
                          ) : m.role === 'learner' ? (
                            <div className="quiz-learner-message w-fit max-w-[85%] text-left text-[0.95rem]">
                              {displayedText}
                              {m.attachments?.map((attachment) => {
                                const preview = Object.values(sentImages)
                                  .flat()
                                  .find((image) => image.id === attachment.id);
                                return preview ? (
                                  <img
                                    key={attachment.id}
                                    src={preview.url}
                                    alt={`Attached ${attachment.mimeType.replace('image/', '')} image`}
                                    className="mt-2 max-h-64 max-w-full rounded object-contain"
                                  />
                                ) : (
                                  <div
                                    key={attachment.id}
                                    role="img"
                                    aria-label="Image unavailable after restart"
                                    className="mt-2 rounded bg-black/20 px-3 py-2 text-xs text-white/70"
                                  >
                                    Image unavailable after restart
                                  </div>
                                );
                              })}
                            </div>
                          ) : (
                            <div className="quiz-agent-markdown w-full text-[0.95rem] text-white/95">
                              <QuizMarkdown
                                reveal={revealingMessageIds.has(m.id)}
                              >
                                {m.text}
                              </QuizMarkdown>
                            </div>
                          )}
                        </article>
                      );
                    })}
                    {session.status === 'connected' && visibleActivity && (
                      <QuizThinkingIndicator activity={visibleActivity} />
                    )}
                    <div
                      aria-hidden="true"
                      style={{ height: composerSpacerHeight }}
                    />
                  </div>
                  <form
                    ref={composerRef}
                    className={`quiz-composer absolute inset-x-0 bottom-3 z-10 mx-auto flex w-[calc(90%_-_1.8rem)] max-w-full min-w-0 shrink-0 flex-col rounded-xl p-1 ${session.currentQuestion?.status === 'open' && qaExpanded ? 'gap-1' : ''}`}
                    onSubmit={(e) => {
                      e.preventDefault();
                      sendComposer();
                    }}
                  >
                    {prompt
                      ? qaExpanded && (
                          <div
                            key={prompt.id}
                            id="quiz-qa-content"
                            className={`${revealingContentId === prompt.id ? 'quiz-new-question' : ''} min-w-0 p-2`}
                          >
                            {prompt.kind === 'next-steps' && (
                              <b className="mb-2 block">Next Steps</b>
                            )}
                            <div className="quiz-agent-markdown mb-3 break-words font-medium">
                              <QuizMarkdown>{prompt.prompt}</QuizMarkdown>
                            </div>
                            {prompt.choices.map((choice) => (
                              <label
                                key={choice.id}
                                className={`quiz-choice-card mb-2 flex cursor-pointer gap-2 break-words rounded-md border border-transparent bg-white/10 px-3 py-2 transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-white ${prompt.selectedChoiceId === choice.id ? 'quiz-choice-card--selected' : ''}`}
                              >
                                <input
                                  className="quiz-choice-radio mt-1 h-4 w-4 shrink-0"
                                  type="radio"
                                  name={`quiz-prompt-${session.id}`}
                                  checked={
                                    prompt.selectedChoiceId === choice.id
                                  }
                                  disabled={!connected || busy}
                                  onChange={() =>
                                    updateContentDraft('currentPrompt', {
                                      selectedChoiceId: choice.id,
                                    })
                                  }
                                />
                                <span className="quiz-agent-markdown min-w-0">
                                  <QuizMarkdown choice>
                                    {choice.text}
                                  </QuizMarkdown>
                                </span>
                              </label>
                            ))}
                            <textarea
                              aria-label="Additional detail"
                              placeholder="Additional detail (optional)"
                              className="mt-2 w-full rounded-lg border border-white/15 bg-black/20 p-2"
                              value={prompt.detailDraft ?? ''}
                              onChange={(e) =>
                                updateContentDraft('currentPrompt', {
                                  detailDraft: e.target.value,
                                })
                              }
                            />
                          </div>
                        )
                      : (session.currentQuestion?.status === 'open' ||
                          session.currentQuestion?.status === 'answered' ||
                          session.currentQuestion?.status === 'feedback') && (
                          <>
                            {qaExpanded && (
                              <div
                                key={
                                  session.currentQuestion?.id ??
                                  session.currentPrompt?.id
                                }
                                id="quiz-qa-content"
                                className={`${revealingContentId === (session.currentQuestion?.id ?? session.currentPrompt?.id) ? 'quiz-new-question' : ''} min-w-0 p-2`}
                              >
                                <QuizLearningTag
                                  learning={session.currentQuestion.learning}
                                />
                                <div className="quiz-agent-markdown mb-3 break-words font-medium">
                                  <QuizMarkdown>
                                    {session.currentQuestion.prompt}
                                  </QuizMarkdown>
                                </div>
                                {session.currentQuestion.status !== 'open' && (
                                  <QuizVerdict
                                    verdict={session.currentQuestion.verdict}
                                    confidence={
                                      session.currentQuestion.confidence
                                    }
                                  />
                                )}
                                {questionKind === 'multiple-choice' &&
                                  session.currentQuestion.choices.map(
                                    (choice) => (
                                      <label
                                        key={choice.id}
                                        className={`quiz-choice-card mb-2 flex cursor-pointer gap-2 break-words rounded-md border border-transparent bg-white/10 px-3 py-2 transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-white ${session.currentQuestion!.selectedChoiceId === choice.id ? 'quiz-choice-card--selected' : ''}`}
                                      >
                                        <input
                                          className="quiz-choice-radio mt-1 h-4 w-4 shrink-0"
                                          type="radio"
                                          name={`quiz-choice-${session.id}`}
                                          disabled={
                                            session.currentQuestion!.status !==
                                            'open'
                                          }
                                          checked={
                                            session.currentQuestion!
                                              .selectedChoiceId === choice.id
                                          }
                                          onChange={() =>
                                            updateContentDraft(
                                              'currentQuestion',
                                              {
                                                selectedChoiceId: choice.id,
                                              },
                                            )
                                          }
                                        />
                                        <span className="quiz-agent-markdown min-w-0">
                                          <QuizMarkdown choice>
                                            {choice.text}
                                          </QuizMarkdown>
                                        </span>
                                      </label>
                                    ),
                                  )}
                                {questionKind === 'matching' &&
                                  session.currentQuestion.status === 'open' && (
                                    <>
                                      {(
                                        session.currentQuestion.leftItems ?? []
                                      ).map((item, itemIndex) => (
                                        <label
                                          key={item.id}
                                          className="mb-2 grid min-w-0 grid-cols-1 items-start gap-2 rounded-lg border border-white/10 bg-white/[0.04] p-2"
                                        >
                                          <span className="flex min-w-0 items-start gap-2">
                                            <span className="shrink-0 rounded bg-white/10 px-2 py-1 font-semibold text-white/70">
                                              {getMatchingItemLabel(
                                                'left',
                                                itemIndex,
                                              )}
                                            </span>
                                            <span className="quiz-agent-markdown min-w-0 break-words">
                                              <QuizMarkdown choice>
                                                {item.text}
                                              </QuizMarkdown>
                                            </span>
                                          </span>
                                          <select
                                            aria-label={`Match for ${getMatchingItemLabel('left', itemIndex)} ${item.text}`}
                                            className="w-full min-w-0 max-w-full truncate rounded border border-white/20 bg-[#22252a] p-2"
                                            value={
                                              session.currentQuestion!
                                                .matchesDraft?.[item.id] ?? ''
                                            }
                                            onChange={(e) => {
                                              const q =
                                                session.currentQuestion!;
                                              const matchesDraft = {
                                                ...q.matchesDraft,
                                              };
                                              if (e.target.value)
                                                matchesDraft[item.id] =
                                                  e.target.value;
                                              else delete matchesDraft[item.id];
                                              updateContentDraft(
                                                'currentQuestion',
                                                {
                                                  matchesDraft,
                                                },
                                              );
                                            }}
                                          >
                                            <option value="">
                                              Choose a match…
                                            </option>
                                            {(
                                              session.currentQuestion!
                                                .rightItems ?? []
                                            ).map((option, optionIndex) => (
                                              <option
                                                key={option.id}
                                                value={option.id}
                                                disabled={Object.entries(
                                                  session.currentQuestion!
                                                    .matchesDraft ?? {},
                                                ).some(
                                                  ([left, right]) =>
                                                    left !== item.id &&
                                                    right === option.id,
                                                )}
                                              >
                                                {`${getMatchingItemLabel('right', optionIndex)} ${option.text}`}
                                              </option>
                                            ))}
                                          </select>
                                        </label>
                                      ))}
                                      {!answerComplete && (
                                        <p
                                          className="mt-2 text-xs text-white/55"
                                          role="status"
                                        >
                                          Match each item with a different
                                          option to continue.
                                        </p>
                                      )}
                                    </>
                                  )}
                                {(questionKind === 'short-answer' ||
                                  questionKind === 'long-answer') &&
                                  session.currentQuestion.status === 'open' && (
                                    <label className="mt-2 block">
                                      Your answer
                                      <textarea
                                        aria-label="Your answer"
                                        rows={
                                          questionKind === 'long-answer' ? 6 : 2
                                        }
                                        className="mt-1 w-full resize-y rounded-lg border border-white/15 bg-black/20 p-2"
                                        value={
                                          session.currentQuestion.textDraft ??
                                          ''
                                        }
                                        onChange={(e) =>
                                          updateContentDraft(
                                            'currentQuestion',
                                            {
                                              textDraft: e.target.value,
                                            },
                                          )
                                        }
                                        onKeyDown={(e) => {
                                          if (questionKind === 'long-answer')
                                            e.stopPropagation();
                                        }}
                                      />
                                    </label>
                                  )}
                                {(questionKind === 'multiple-choice' ||
                                  questionKind === 'matching') &&
                                  session.currentQuestion.status === 'open' && (
                                    <>
                                      <textarea
                                        className="mt-3 w-full rounded-lg border border-white/15 bg-black/20 p-2"
                                        placeholder="Your reasoning (optional)"
                                        value={
                                          session.currentQuestion.reasoningDraft
                                        }
                                        onChange={(e) =>
                                          updateContentDraft(
                                            'currentQuestion',
                                            {
                                              reasoningDraft: e.target.value,
                                            },
                                          )
                                        }
                                      />
                                    </>
                                  )}
                                {session.currentQuestion.status === 'open' && (
                                  <QuizAnswerActions
                                    questionId={session.currentQuestion.id}
                                    confidence={confidence}
                                    answerComplete={answerComplete}
                                    connected={connected}
                                    busy={busy}
                                    onConfidenceChange={(value) =>
                                      setConfidenceRating({
                                        questionId: session.currentQuestion!.id,
                                        value,
                                      })
                                    }
                                    onSkip={() => send('skip')}
                                    onSubmit={() => send('answer')}
                                  />
                                )}
                              </div>
                            )}
                          </>
                        )}
                    <div className="flex min-w-0 items-center gap-1">
                      <div className="flex min-w-0 flex-1 flex-col">
                        {!!sessionImages.length && (
                          <div className="flex flex-wrap gap-2 px-2 pt-2">
                            {sessionImages.map((image) => (
                              <span key={image.id} className="relative">
                                <img
                                  src={image.url}
                                  alt="Image attachment preview"
                                  className="h-16 w-16 rounded object-cover"
                                />
                                <button
                                  type="button"
                                  aria-label="Remove image attachment"
                                  className="absolute -right-1 -top-1 rounded-full bg-black px-1"
                                  onClick={() => {
                                    void bridge.removeImage(
                                      session.id,
                                      image.id,
                                    );
                                    URL.revokeObjectURL(image.url);
                                    setPendingImages((current) => ({
                                      ...current,
                                      [session.id]: (
                                        current[session.id] ?? []
                                      ).filter(
                                        (entry) => entry.id !== image.id,
                                      ),
                                    }));
                                  }}
                                >
                                  ×
                                </button>
                              </span>
                            ))}
                          </div>
                        )}
                        <div className="relative flex min-w-0">
                          <textarea
                            ref={messageInputRef}
                            onPaste={(event) => {
                              const files = getClipboardImages(
                                event.clipboardData,
                              );
                              if (!files.length || !session || !bridge) return;
                              event.preventDefault();
                              void (async () => {
                                if (deletedSessions.current.has(session.id))
                                  return;
                                const existing =
                                  imagesRef.current[session.id] ?? [];
                                let remainingBytes = Math.max(
                                  0,
                                  10 * 1024 * 1024 -
                                    existing.reduce(
                                      (sum, image) => sum + image.size,
                                      0,
                                    ),
                                );
                                for (const file of files.slice(
                                  0,
                                  Math.max(0, 4 - existing.length),
                                )) {
                                  if (file.size > remainingBytes) {
                                    setError(
                                      'Images are limited to 10 MB per message.',
                                    );
                                    continue;
                                  }
                                  remainingBytes -= file.size;
                                  const result = await bridge.addImage(
                                    session.id,
                                    {
                                      mimeType: file.type,
                                      data: new Uint8Array(
                                        await file.arrayBuffer(),
                                      ),
                                    },
                                  );
                                  if (!result.ok) {
                                    setError(
                                      `Could not add image: ${result.error}`,
                                    );
                                    continue;
                                  }
                                  if (deletedSessions.current.has(session.id)) {
                                    void bridge
                                      .removeImage(session.id, result.value.id)
                                      .catch(() => undefined);
                                    continue;
                                  }
                                  const image = {
                                    ...result.value,
                                    url: URL.createObjectURL(file),
                                  };
                                  setPendingImages((current) => ({
                                    ...current,
                                    [session.id]: [
                                      ...(current[session.id] ?? []),
                                      image,
                                    ],
                                  }));
                                }
                              })().catch(() =>
                                setError('Could not read clipboard image.'),
                              );
                            }}
                            rows={1}
                            className="quiz-composer-input min-w-0 flex-1 rounded-2xl border-0 py-1.5 pl-3 pr-10 outline-none"
                            placeholder="Write a message"
                            aria-label="Write a message"
                            onKeyDown={(event) =>
                              handleQuizComposerEnter(
                                {
                                  key: event.key,
                                  shiftKey: event.shiftKey,
                                  isComposing: event.nativeEvent.isComposing,
                                  preventDefault: () => event.preventDefault(),
                                },
                                connected &&
                                  !busy &&
                                  (hasChatMessage || canRespondPrompt),
                                sendComposer,
                              )
                            }
                            value={draft}
                            onChange={(e) => {
                              const value = e.target.value;
                              setDraft(value);
                              if (session) persistDraft(session.id);
                            }}
                            onBlur={() => {
                              if (session) persistDraft(session.id, true);
                            }}
                          />
                          <button
                            type="submit"
                            disabled={
                              !connected ||
                              busy ||
                              (!hasChatMessage && !canRespondPrompt)
                            }
                            aria-label={
                              !hasChatMessage && canRespondPrompt
                                ? 'Respond to prompt'
                                : 'Send message'
                            }
                            title={
                              !hasChatMessage && canRespondPrompt
                                ? 'Respond to prompt'
                                : 'Send message'
                            }
                            className="absolute right-1 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-white/75 hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            <FaTelegram aria-hidden="true" size={21} />
                          </button>
                        </div>
                      </div>
                      {composerActions.showContinue && (
                        <button
                          type="button"
                          disabled={!connected || busy}
                          className="quiz-action-button shrink-0 rounded px-3.5 py-1.5 text-xs disabled:opacity-40"
                          onClick={() => send('continue')}
                        >
                          Continue
                        </button>
                      )}
                      {session.currentQuestion?.status === 'open' && (
                        <button
                          type="button"
                          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white/65 hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
                          aria-expanded={qaExpanded}
                          aria-controls="quiz-qa-content"
                          aria-label={
                            qaExpanded ? 'Collapse Q&A' : 'Expand Q&A'
                          }
                          title={qaExpanded ? 'Collapse Q&A' : 'Expand Q&A'}
                          onClick={() => setQaExpanded((expanded) => !expanded)}
                        >
                          {qaExpanded ? (
                            <IoChevronDown aria-hidden="true" />
                          ) : (
                            <IoChevronUp aria-hidden="true" />
                          )}
                        </button>
                      )}
                    </div>
                    {composerActions.showDisconnectedStatus && (
                      <span className="px-2 pb-1 text-center text-[11px] text-white/45">
                        Connect an agent to send.
                      </span>
                    )}
                  </form>
                </div>
              </>
            ) : showSessionList ? (
              <div
                className="quiz-session-picker min-h-0 flex-1 overflow-y-auto p-3"
                aria-label="Quiz sessions"
              >
                <div className="mb-3">
                  <input
                    type="text"
                    aria-label="Search sessions"
                    value={sessionSearch}
                    onChange={(event) => setSessionSearch(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape' && sessionSearch) {
                        event.preventDefault();
                        setSessionSearch('');
                      }
                    }}
                    placeholder="Search sessions"
                    className="w-full border-0 bg-transparent p-1 text-sm text-white placeholder:text-white/40 focus-visible:outline focus-visible:outline-1 focus-visible:outline-white/50"
                  />
                </div>
                {(() => {
                  const query = sessionSearch.trim().toLocaleLowerCase();
                  const visibleSessions = sessions.filter((item) => {
                    const source = item.scope
                      ? item.scope.notePath ||
                        item.scope.folderPath ||
                        item.scope.selectedNotePaths.join(', ') ||
                        'Entire vault'
                      : 'Sources not selected';
                    const scope = item.scope
                      ? item.scope.notePath
                        ? 'note'
                        : item.scope.folderPath
                          ? 'folder'
                          : item.scope.selectedNotePaths.length
                            ? 'selected'
                            : 'vault'
                      : 'unscoped';
                    return (
                      !query ||
                      `${item.name ?? ''} ${source} ${scope}`
                        .toLocaleLowerCase()
                        .includes(query)
                    );
                  });
                  return (
                    <>
                      <ul className="m-0 list-none space-y-1 p-0">
                        {visibleSessions.map((item) => {
                          const source = item.scope
                            ? item.scope.notePath ||
                              item.scope.folderPath ||
                              item.scope.selectedNotePaths.join(', ') ||
                              'Entire vault'
                            : 'Sources not selected';
                          const label = item.name || source;
                          const status =
                            item.status === 'connected'
                              ? 'Connected'
                              : item.status === 'waiting-agent'
                                ? 'Waiting for agent'
                                : 'Disconnected';
                          return (
                            <li
                              key={item.id}
                              className={`quiz-session-row flex items-center gap-2 rounded-lg border px-1.5 py-1 ${session?.id === item.id ? 'bg-white/[0.035]' : ''}`}
                            >
                              <button
                                type="button"
                                className="min-w-0 flex-1 cursor-pointer rounded px-2 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
                                aria-current={
                                  session?.id === item.id ? 'true' : undefined
                                }
                                onClick={() => {
                                  void openSession(item.id);
                                  setShowSessionList(false);
                                }}
                              >
                                <span className="block truncate text-sm text-white/90">
                                  {label}
                                </span>
                                <span className="mt-0.5 block truncate text-xs text-white/45">
                                  {source} <span aria-hidden="true">·</span>{' '}
                                  {status}
                                </span>
                              </button>
                              {confirmDelete === item.id ? (
                                <span
                                  className="flex shrink-0 items-center gap-1 text-xs"
                                  aria-live="polite"
                                >
                                  <span>Delete session data only?</span>
                                  <button
                                    type="button"
                                    disabled={deleting !== null}
                                    className="rounded px-2 py-2 text-red-300 hover:bg-red-400/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white disabled:opacity-40"
                                    onClick={() => void deleteSession(item.id)}
                                  >
                                    Delete
                                  </button>
                                  <button
                                    type="button"
                                    className="rounded px-2 py-2 text-white/65 hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
                                    onClick={() => setConfirmDelete(null)}
                                  >
                                    Cancel
                                  </button>
                                </span>
                              ) : (
                                <>
                                  {editingSessionId === item.id ? (
                                    <input
                                      autoFocus
                                      aria-label="Session name"
                                      className="w-36 rounded border border-white/20 bg-black/20 px-2 py-2 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
                                      value={sessionName}
                                      onChange={(event) =>
                                        setSessionName(event.target.value)
                                      }
                                      onKeyDown={(event) => {
                                        if (event.key === 'Escape')
                                          setEditingSessionId(null);
                                        if (event.key === 'Enter') {
                                          event.preventDefault();
                                          const name = sessionName.trim();
                                          if (!name || !bridge) return;
                                          void bridge
                                            .renameSession(item.id, name)
                                            .then((result) => {
                                              if (result.ok) {
                                                setSessions((items) =>
                                                  items.map((value) =>
                                                    value.id === item.id
                                                      ? result.value
                                                      : value,
                                                  ),
                                                );
                                                if (
                                                  sessionRef.current?.id ===
                                                  item.id
                                                )
                                                  setSession(result.value);
                                                setEditingSessionId(null);
                                              } else
                                                setError(
                                                  `Could not rename session: ${result.error}`,
                                                );
                                            })
                                            .catch(() =>
                                              setError(
                                                'Could not rename session.',
                                              ),
                                            );
                                        }
                                      }}
                                      onBlur={() => setEditingSessionId(null)}
                                    />
                                  ) : (
                                    <button
                                      type="button"
                                      aria-label={`Rename session ${label}`}
                                      title="Rename session"
                                      className="cursor-pointer rounded p-2 text-white/50 hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
                                      onClick={() => {
                                        setSessionName(item.name || '');
                                        setEditingSessionId(item.id);
                                      }}
                                    >
                                      <FaPencil aria-hidden="true" size={12} />
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    aria-label={`Delete session ${label}`}
                                    title="Delete session and its data only"
                                    disabled={deleting !== null}
                                    className="cursor-pointer rounded p-2 text-white/50 hover:bg-red-400/10 hover:text-red-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white disabled:opacity-40"
                                    onClick={() => setConfirmDelete(item.id)}
                                  >
                                    <FaTrash aria-hidden="true" size={12} />
                                  </button>
                                </>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                      {sessions.length === 0 ? (
                        <p className="px-2 py-4 text-sm text-white/50">
                          No sessions yet.
                        </p>
                      ) : visibleSessions.length === 0 ? (
                        <p className="px-2 py-4 text-sm text-white/50">
                          No results.{' '}
                          <button
                            type="button"
                            className="underline hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
                            onClick={() => setSessionSearch('')}
                          >
                            Clear search
                          </button>
                        </p>
                      ) : null}
                    </>
                  );
                })()}
              </div>
            ) : !session ? (
              <div className="min-h-0 flex-1 overflow-y-auto p-5">
                <p className="text-sm text-white/60">
                  Choose + to start a new session.
                </p>
                {error && (
                  <p role="alert" className="mt-3 text-sm text-red-300">
                    {error}
                  </p>
                )}
              </div>
            ) : null}
          </>
        )}
      </section>
    </QuizMarkdownAppearanceContext.Provider>
  );
}

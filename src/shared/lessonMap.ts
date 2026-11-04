/**
 * Live lesson dependency map for a quiz session. The tutor sends a structured
 * graph whose node IDs are concept slugs; Storm validates it, builds the
 * Mermaid source itself, and highlights the node currently being taught.
 */
import { QUIZ_CONCEPT_ID } from './quizProtocol';

export type LessonNodeStatus =
  | 'not-started'
  | 'introduced'
  | 'guided'
  | 'independent'
  | 'mastered'
  | 'needs-review';
export const LESSON_NODE_STATUSES: readonly LessonNodeStatus[] = [
  'not-started',
  'introduced',
  'guided',
  'independent',
  'mastered',
  'needs-review',
];

export type LessonMapNode = { id: string; label: string };
export type QuizLessonMap = {
  nodes: LessonMapNode[];
  /** [prerequisite, dependent] pairs. */
  edges: Array<[string, string]>;
  goal?: string;
  statuses: Record<string, LessonNodeStatus>;
  /** Concept slugs currently being taught. */
  focus: string[];
  /** Increases on every change so concurrent session writes keep the newest map. */
  version: number;
  updatedAt: string;
};

/** Agent update: send nodes+edges to replace the graph; statuses/focus/goal merge. */
export type LessonMapUpdate = {
  nodes?: LessonMapNode[];
  edges?: Array<[string, string]>;
  goal?: string | null;
  statuses?: Record<string, LessonNodeStatus>;
  focus?: string[];
};

export const LESSON_MAP_LIMITS = { nodes: 40, edges: 120, label: 80, focus: 3 };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

function acyclic(ids: string[], edges: Array<[string, string]>): boolean {
  const out = new Map(ids.map((id) => [id, [] as string[]]));
  for (const [from, to] of edges) out.get(from)!.push(to);
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 2) return true;
    if (state.get(id) === 1) return false;
    state.set(id, 1);
    for (const next of out.get(id)!) if (!visit(next)) return false;
    state.set(id, 2);
    return true;
  };
  return ids.every(visit);
}

/** Shape check for an untrusted update; semantic checks happen in applyLessonMapUpdate. */
export function isLessonMapUpdate(value: unknown): value is LessonMapUpdate {
  if (!isRecord(value)) return false;
  const { nodes, edges, goal, statuses, focus } = value;
  if ((nodes === undefined) !== (edges === undefined)) return false;
  if (
    nodes !== undefined &&
    (!Array.isArray(nodes) ||
      nodes.length < 1 ||
      nodes.length > LESSON_MAP_LIMITS.nodes ||
      !nodes.every(
        (n) =>
          isRecord(n) &&
          typeof n.id === 'string' &&
          QUIZ_CONCEPT_ID.test(n.id) &&
          typeof n.label === 'string' &&
          n.label.trim().length > 0 &&
          n.label.length <= LESSON_MAP_LIMITS.label,
      ))
  )
    return false;
  if (
    edges !== undefined &&
    (!Array.isArray(edges) ||
      edges.length > LESSON_MAP_LIMITS.edges ||
      !edges.every(
        (e) =>
          Array.isArray(e) &&
          e.length === 2 &&
          e.every((id) => typeof id === 'string'),
      ))
  )
    return false;
  if (goal !== undefined && goal !== null && typeof goal !== 'string')
    return false;
  if (
    statuses !== undefined &&
    (!isRecord(statuses) ||
      Object.keys(statuses).length > LESSON_MAP_LIMITS.nodes ||
      !Object.values(statuses).every((s) =>
        LESSON_NODE_STATUSES.includes(s as LessonNodeStatus),
      ))
  )
    return false;
  if (
    focus !== undefined &&
    (!Array.isArray(focus) ||
      focus.length > LESSON_MAP_LIMITS.focus ||
      !focus.every((id) => typeof id === 'string'))
  )
    return false;
  return true;
}

/** Returns the merged map, or an error string describing why the update is invalid. */
export function applyLessonMapUpdate(
  current: QuizLessonMap | undefined,
  update: LessonMapUpdate,
  now: string,
): QuizLessonMap | string {
  if (!update.nodes && !current)
    return 'The first map update must include nodes and edges.';
  const nodes = update.nodes
    ? update.nodes.map((n) => ({ id: n.id, label: n.label.trim() }))
    : current!.nodes;
  const ids = nodes.map((n) => n.id);
  if (new Set(ids).size !== ids.length) return 'Node IDs must be unique.';
  const known = new Set(ids);
  const edges = update.edges ?? current!.edges;
  const edgeKeys = new Set<string>();
  for (const [from, to] of edges) {
    if (!known.has(from) || !known.has(to))
      return `Edge ${from} -> ${to} references an unknown node.`;
    if (from === to) return `Edge ${from} -> ${to} is a self-loop.`;
    const key = `${from}\n${to}`;
    if (edgeKeys.has(key)) return `Duplicate edge ${from} -> ${to}.`;
    edgeKeys.add(key);
  }
  if (update.nodes && !acyclic(ids, edges))
    return 'The dependency map must not contain cycles.';
  const goal =
    update.goal === null ? undefined : (update.goal ?? current?.goal);
  if (goal !== undefined && !known.has(goal))
    return `Goal ${goal} is not a node.`;
  for (const id of [
    ...Object.keys(update.statuses ?? {}),
    ...(update.focus ?? []),
  ])
    if (!known.has(id)) return `Unknown node ${id}.`;
  // Keep statuses for nodes that survive a graph replacement.
  const statuses: Record<string, LessonNodeStatus> = {};
  for (const [id, status] of Object.entries({
    ...current?.statuses,
    ...update.statuses,
  }))
    if (known.has(id)) statuses[id] = status;
  const focus = (update.focus ?? current?.focus ?? []).filter((id) =>
    known.has(id),
  );
  return {
    nodes,
    edges,
    ...(goal !== undefined ? { goal } : {}),
    statuses,
    focus: [...new Set(focus)],
    version: (current?.version ?? 0) + 1,
    updatedAt: now,
  };
}

/** Moves focus to a newly posed question's mapped concepts, if any. */
export function focusLessonMap(
  map: QuizLessonMap | undefined,
  concepts: string[] | undefined,
  now: string,
): QuizLessonMap | undefined {
  if (!map || !concepts?.length) return map;
  const known = new Set(map.nodes.map((n) => n.id));
  const focus = concepts.filter((id) => known.has(id));
  if (!focus.length || focus.join() === map.focus.join()) return map;
  return { ...map, focus, version: map.version + 1, updatedAt: now };
}

/** Mermaid flowchart source. Nodes are `n<index>` and edges `e<index>` so the
 * rendered SVG (node element IDs, edge data-id) maps back to slugs without
 * parsing labels. */
export function lessonMapMermaid(map: QuizLessonMap): string {
  const index = new Map(map.nodes.map((n, i) => [n.id, i]));
  const label = (text: string) =>
    text.replace(/["#<>\\`]/g, (c) => `#${c.charCodeAt(0)};`);
  const lines = ['flowchart LR'];
  map.nodes.forEach((n, i) => lines.push(`  n${i}["${label(n.label)}"]`));
  map.edges.forEach(([from, to], i) =>
    lines.push(`  n${index.get(from)} e${i}@--> n${index.get(to)}`),
  );
  return lines.join('\n');
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyLessonMapUpdate,
  focusLessonMap,
  isLessonMapUpdate,
  lessonMapMermaid,
  type QuizLessonMap,
} from './lessonMap';

const now = '2026-11-03T00:00:00.000Z';
const graph = {
  nodes: [
    { id: 'identity-laws', label: 'Identity laws' },
    { id: 'constant-laws', label: 'Constant "laws"' },
    { id: 'simplify', label: 'Simplify expressions' },
  ],
  edges: [
    ['identity-laws', 'constant-laws'],
    ['constant-laws', 'simplify'],
  ] as Array<[string, string]>,
  goal: 'simplify',
};
const base = applyLessonMapUpdate(undefined, graph, now) as QuizLessonMap;

test('creates a map and merges later status/focus updates', () => {
  assert.equal(typeof base, 'object');
  assert.equal(base.version, 1);
  assert.deepEqual(base.focus, []);
  const next = applyLessonMapUpdate(
    base,
    { statuses: { 'identity-laws': 'mastered' }, focus: ['constant-laws'] },
    now,
  ) as QuizLessonMap;
  assert.equal(next.version, 2);
  assert.deepEqual(next.nodes, base.nodes);
  assert.deepEqual(next.statuses, { 'identity-laws': 'mastered' });
  assert.deepEqual(next.focus, ['constant-laws']);
  assert.equal(next.goal, 'simplify');
});

test('replacing the graph keeps statuses only for surviving nodes', () => {
  const withStatus = applyLessonMapUpdate(
    base,
    { statuses: { 'identity-laws': 'guided', simplify: 'introduced' } },
    now,
  ) as QuizLessonMap;
  const replaced = applyLessonMapUpdate(
    withStatus,
    {
      nodes: [{ id: 'identity-laws', label: 'Identity' }],
      edges: [],
      goal: null,
    },
    now,
  ) as QuizLessonMap;
  assert.deepEqual(replaced.statuses, { 'identity-laws': 'guided' });
  assert.equal(replaced.goal, undefined);
});

test('rejects invalid graphs with a specific reason', () => {
  assert.match(
    String(applyLessonMapUpdate(undefined, { focus: ['x'] }, now)),
    /first map update/,
  );
  assert.match(
    String(
      applyLessonMapUpdate(
        undefined,
        { ...graph, edges: [...graph.edges, ['simplify', 'identity-laws']] },
        now,
      ),
    ),
    /cycles/,
  );
  assert.match(
    String(applyLessonMapUpdate(base, { focus: ['missing'] }, now)),
    /Unknown node/,
  );
  assert.match(
    String(
      applyLessonMapUpdate(
        undefined,
        { nodes: graph.nodes, edges: [['identity-laws', 'nope']] },
        now,
      ),
    ),
    /unknown node/,
  );
  assert.equal(isLessonMapUpdate({ nodes: graph.nodes }), false);
  assert.equal(
    isLessonMapUpdate({ nodes: [{ id: 'Bad Slug', label: 'x' }], edges: [] }),
    false,
  );
  assert.equal(isLessonMapUpdate({ statuses: { a: 'expert' } }), false);
  assert.equal(isLessonMapUpdate(graph), true);
});

test('posing a question moves focus only to mapped concepts', () => {
  const focused = focusLessonMap(base, ['constant-laws', 'unmapped'], now)!;
  assert.deepEqual(focused.focus, ['constant-laws']);
  assert.equal(focused.version, base.version + 1);
  assert.equal(focusLessonMap(base, ['unmapped'], now), base);
  assert.equal(focusLessonMap(undefined, ['constant-laws'], now), undefined);
});

test('builds Mermaid with index IDs and escaped labels', () => {
  const source = lessonMapMermaid(base);
  assert.equal(
    source,
    [
      'flowchart LR',
      '  n0["Identity laws"]',
      '  n1["Constant #34;laws#34;"]',
      '  n2["Simplify expressions"]',
      '  n0 e0@--> n1',
      '  n1 e1@--> n2',
    ].join('\n'),
  );
});

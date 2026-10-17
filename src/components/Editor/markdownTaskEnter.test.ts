import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { markdown } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { markdownTaskEnter, markdownTaskX } from './markdownTaskEnter';

function press(
  source: string,
  cursor = 0,
  vimState?: { insertMode: boolean; visualMode: boolean },
  selected = false,
) {
  const state = EditorState.create({
    doc: source,
    extensions: [markdown()],
    selection: selected
      ? { anchor: cursor, head: cursor + 1 }
      : { anchor: cursor },
  });
  let nextState = state;
  const view = {
    get state() {
      return nextState;
    },
    cm: vimState ? { state: { vim: vimState } } : null,
    dispatch: (spec: Parameters<typeof state.update>[0]) =>
      (nextState = nextState.update(spec).state),
  } as unknown as EditorView;
  const handled = markdownTaskEnter(view);
  return { handled, nextState };
}

const normal = { insertMode: false, visualMode: false };

function pressX(
  source: string,
  cursor = 0,
  vimState?: { insertMode: boolean; visualMode: boolean },
) {
  const state = EditorState.create({
    doc: source,
    extensions: [markdown()],
    selection: { anchor: cursor },
  });
  let nextState = state;
  const view = {
    get state() {
      return nextState;
    },
    cm: vimState ? { state: { vim: vimState } } : null,
    dispatch: (spec: Parameters<typeof state.update>[0]) =>
      (nextState = nextState.update(spec).state),
  } as unknown as EditorView;
  const handled = markdownTaskX(view);
  return { handled, nextState };
}

describe('source task Enter cycle', () => {
  it('toggles between list and unchecked task while preserving indentation and text', () => {
    for (const [source, expected] of [
      ['task', '- task'],
      ['- task', '- [ ] task'],
      ['- [ ] task', '- task'],
      ['- [x] task', '- task'],
      ['- [X] task', '- task'],
      ['  - [ ] nested', '  - nested'],
      ['\t- [x] tabbed', '\t- tabbed'],
      ['3. item', '3. [ ] item'],
      ['3. [ ] item', '3. item'],
      ['3. [x] item', '3. item'],
      ['', '- '],
    ]) {
      const result = press(source, source.length, normal);
      assert.equal(result.handled, true, source);
      assert.equal(result.nextState.doc.toString(), expected, source);
      assert.equal(
        result.nextState.selection.main.head,
        expected.length,
        source,
      );
    }
  });

  it('preserves content spacing and supports cursor positions in the line', () => {
    const source = '  - [x]  keep  spaces';
    const result = press(source, 0, normal);
    assert.equal(result.nextState.doc.toString(), '  - keep  spaces');
    assert.equal(result.nextState.selection.main.head, 0);
  });

  it('toggles task checkboxes with x only in initialized Vim Normal mode', () => {
    for (const [source, expected] of [
      ['- [ ] task', '- [x] task'],
      ['- [x] task', '- [ ] task'],
      ['- [X] task', '- [ ] task'],
      ['  3. [ ] nested', '  3. [x] nested'],
    ]) {
      const result = pressX(
        source,
        source.indexOf('task') >= 0 ? source.indexOf('task') : source.length,
        normal,
      );
      assert.equal(result.handled, true, source);
      assert.equal(result.nextState.doc.toString(), expected, source);
    }
    assert.equal(pressX('- item', 0, normal).handled, false);
    assert.equal(pressX('- [ ] task').handled, false);
    assert.equal(
      pressX('- [ ] task', 0, { insertMode: true, visualMode: false }).handled,
      false,
    );
    assert.equal(
      pressX('- [ ] task', 0, { insertMode: false, visualMode: true }).handled,
      false,
    );
  });

  it('only cycles in initialized Vim Normal mode', () => {
    for (const vimState of [
      { insertMode: true, visualMode: false },
      { insertMode: false, visualMode: true },
    ]) {
      assert.equal(press('- [ ] task', 0, vimState).handled, false);
    }
    assert.equal(press('- [ ] task').handled, false);
    assert.equal(press('- [ ] task', 0, normal, true).handled, false);
    assert.equal(press('- [ ] task', 0, normal).handled, true);
  });

  it('leaves code, tables, structural Markdown, and selections untouched', () => {
    for (const source of [
      '`- [ ] inline`',
      '```md\n- [ ] fenced\n```',
      '| cell |',
      '# Heading',
      '> quote',
    ]) {
      const cursor = source.indexOf('-') >= 0 ? source.indexOf('-') : 0;
      assert.equal(press(source, cursor, normal).handled, false, source);
    }
  });
});

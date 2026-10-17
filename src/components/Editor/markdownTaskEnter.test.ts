import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { markdown } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { markdownTaskEnter } from './markdownTaskEnter';

function press(source: string, cursor = 0, selected = false) {
  const state = EditorState.create({
    doc: source,
    extensions: [markdown()],
    selection: selected
      ? { anchor: cursor, head: cursor + 1 }
      : { anchor: cursor },
  });
  let nextState: EditorState | undefined;
  const view = {
    state,
    dispatch: (spec: Parameters<typeof state.update>[0]) =>
      (nextState = state.update(spec).state),
  } as unknown as EditorView;
  const handled = markdownTaskEnter(view);
  return { handled, nextState };
}

describe('source task Enter toggle', () => {
  it('toggles common task markers while preserving the cursor', () => {
    for (const source of [
      '- [ ] task',
      '- [x] task',
      '  - [X] nested',
      '2. [ ] ordered',
    ]) {
      const result = press(source, source.length);
      assert.equal(result.handled, true, source);
      assert.equal(
        result.nextState?.doc.toString(),
        source.replace(
          /\[([ xX])\]/,
          (_, state) => `[${state === ' ' ? 'x' : ' '}]`,
        ),
      );
      assert.equal(result.nextState?.selection.main.head, source.length);
    }
  });

  it('leaves non-task, code, and selected text untouched', () => {
    for (const source of [
      'ordinary text',
      '`- [ ] inline`',
      '```md\n- [ ] fenced\n```',
    ]) {
      assert.equal(
        press(source, source.indexOf('-') >= 0 ? source.indexOf('-') : 0)
          .handled,
        false,
        source,
      );
    }
    assert.equal(press('- [ ] selected', 3, true).handled, false);
  });
});

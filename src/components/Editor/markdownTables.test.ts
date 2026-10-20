import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EditorState } from '@codemirror/state';
import { markdownTableEnter } from './markdownTables';

function pressEnter(
  text: string,
  vimState?: { insertMode: boolean; visualMode: boolean },
) {
  let state = EditorState.create({
    doc: text,
    selection: { anchor: text.length },
  });
  const view = {
    get state() {
      return state;
    },
    dispatch(transaction: Parameters<typeof state.update>[0]) {
      state = state.update(transaction).state;
    },
    cm: vimState ? { state: { vim: vimState } } : null,
  } as never;
  const handled = markdownTableEnter(view);
  return { handled, text: state.doc.toString() };
}

describe('markdown table Enter', () => {
  it('creates separator and first body row after a header', () => {
    assert.equal(
      pressEnter('| A | B |').text,
      '| A | B |\n| --- | --- |\n|  |  |',
    );
  });
  it('continues an existing separator with a body row', () => {
    assert.equal(
      pressEnter('| A | B |\n| --- | --- |').text,
      '| A | B |\n| --- | --- |\n|  |  |',
    );
  });
  it('continues a body row with the same number of columns', () => {
    assert.equal(
      pressEnter('| A | B |\n| --- | --- |\n| x | y |').text,
      '| A | B |\n| --- | --- |\n| x | y |\n|  |  |',
    );
  });
  it('removes an empty final table row to exit', () => {
    assert.equal(
      pressEnter('| A | B |\n| --- | --- |\n| x | y |\n|  |  |').text,
      '| A | B |\n| --- | --- |\n| x | y |',
    );
  });
  it('does not remove an empty row before a nonempty row', () => {
    assert.equal(
      pressEnter('| A | B |\n| --- | --- |\n|  |  |\n| x | y |').text,
      '| A | B |\n| --- | --- |\n|  |  |\n| x | y |\n|  |  |',
    );
  });
  for (const fence of ['```', '~~~']) {
    it(`ignores a table-like line in ${fence} fenced code`, () => {
      assert.equal(pressEnter(`${fence}\n| A | B |`).handled, false);
    });
  }
  it('ignores ordinary text', () => {
    assert.equal(pressEnter('plain text').handled, false);
  });
  it('counts escaped pipes and pipes inside inline code as cell content', () => {
    const text = '| A\\|B | `x|y` |\n| --- | --- |';
    assert.equal(pressEnter(text).text, `${text}\n|  |  |`);
  });
  it('runs in Vim Insert mode but not Normal or Visual mode', () => {
    const table = '| A | B |';
    assert.equal(
      pressEnter(table, { insertMode: true, visualMode: false }).handled,
      true,
    );
    assert.equal(
      pressEnter(table, { insertMode: false, visualMode: false }).handled,
      false,
    );
    assert.equal(
      pressEnter(table, { insertMode: true, visualMode: true }).handled,
      false,
    );
  });
});

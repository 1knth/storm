import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { planRenameLinks } from './renameLinks';

test('rewrites moved file links and preserves alias, fragments, code, and unrelated syntax', () => {
  const result = planRenameLinks(
    [
      { path: 'notes/old.md', content: '# note' },
      {
        path: 'notes/ref.md',
        content:
          '[[old|label]] [read](old.md#part) ![img](old.png)\n\n`[[old]]`\n\n```md\n[old](old)\n```',
      },
    ],
    'notes/old.md',
    'notes/new.md',
  );
  assert.equal(
    result[1].content,
    '[[new|label]] [read](new.md#part) ![img](old.png)\n\n`[[old]]`\n\n```md\n[old](old)\n```',
  );
  assert.equal(result[1].updates, 2);
});

test('updates links from notes that move with a folder, including encoded image URLs and anchors', () => {
  const result = planRenameLinks(
    [
      {
        path: 'old/ref.md',
        content:
          '[alias](../target%20file.md#part) ![image](../photo%20one.png?size=small#view) [[../target file|label]] ` [skip](../target file.md) `\n\n```md\n![skip](../target%20file.md)\n```',
      },
      { path: 'target file.md', content: '' },
      { path: 'photo one.png', content: '' },
    ],
    'old',
    'new',
  );
  assert.equal(
    result[0].content,
    '[alias](../target%20file.md#part) ![image](../photo%20one.png?size=small#view) [[../target file|label]] ` [skip](../target file.md) `\n\n```md\n![skip](../target%20file.md)\n```',
  );
  // The moved note's relative depth is unchanged, so these relative URLs stay valid.
  assert.equal(result[0].path, 'new/ref.md');
});

test('rewrites encoded URLs when the target itself moves and preserves anchors and aliases', () => {
  const result = planRenameLinks(
    [
      { path: 'dir/old name.md', content: '' },
      {
        path: 'ref.md',
        content:
          '[alias](dir/old%20name.md#part) ![image](dir/old%20name.md?size=1) [[dir/old name#part|label]]',
      },
    ],
    'dir/old name.md',
    'dir/new name.md',
  );
  assert.equal(
    result[1].content,
    '[alias](dir/new%20name.md#part) ![image](dir/new%20name.md?size=1) [[dir/new name#part|label]]',
  );
});

test('remaps relative links from moved folder notes and leaves ambiguous links alone', () => {
  const result = planRenameLinks(
    [
      {
        path: 'dir/a.md',
        content: '[inside](b%20c.md) [outside](../outside.md) [[dupe]]',
      },
      { path: 'dir/b c.md', content: '' },
      { path: 'outside.md', content: '' },
      { path: 'one/dupe.md', content: '' },
      { path: 'two/dupe.md', content: '' },
    ],
    'dir',
    'renamed',
  );
  assert.equal(result[0].path, 'renamed/a.md');
  assert.equal(
    result[0].content,
    '[inside](b%20c.md) [outside](../outside.md) [[dupe]]',
  );
});

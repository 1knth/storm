import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VaultEntry } from '../shared/types';
import { filterPickerEntries } from './filePickerEntries';

const entries: VaultEntry[] = [
  {
    kind: 'note',
    path: 'Guides/Setup.md',
    name: 'Setup.md',
    isDirectory: false,
    peek: '',
  },
  {
    kind: 'image',
    path: 'Assets/Cover.PNG',
    name: 'Cover.PNG',
    isDirectory: false,
    peek: '',
  },
  {
    kind: 'directory',
    path: 'Guides',
    name: 'Guides',
    isDirectory: true,
    peek: '',
  },
];

test('filterPickerEntries matches paths case-insensitively and trims query whitespace', () => {
  assert.deepEqual(filterPickerEntries(entries, '  guides/SET  '), [
    entries[0],
  ]);
});

test('filterPickerEntries includes images and excludes directories when query is empty', () => {
  assert.deepEqual(filterPickerEntries(entries, ''), entries.slice(0, 2));
});

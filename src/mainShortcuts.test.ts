import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isToggleExplorerShortcut,
  isToggleVaultsShortcut,
} from './mainShortcuts';

const shortcut = (overrides: Partial<KeyboardEvent> = {}) => ({
  key: 's',
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...overrides,
});

describe('main sidebar shortcuts', () => {
  for (const [platform, primary] of [
    ['macOS', { metaKey: true }],
    ['Windows/Linux', { ctrlKey: true }],
  ] as const) {
    it(`separates explorer Cmd/Ctrl+S from vaults Cmd/Ctrl+Shift+S on ${platform}`, () => {
      const plain = shortcut(primary);
      const shifted = shortcut({ ...primary, shiftKey: true });
      assert.equal(
        isToggleExplorerShortcut(plain, platform === 'macOS', true),
        true,
      );
      assert.equal(
        isToggleVaultsShortcut(plain, platform === 'macOS', true),
        false,
      );
      assert.equal(
        isToggleExplorerShortcut(shifted, platform === 'macOS', true),
        false,
      );
      assert.equal(
        isToggleVaultsShortcut(shifted, platform === 'macOS', true),
        true,
      );
    });

    it(`honors disabled settings and rejects extraneous modifiers on ${platform}`, () => {
      assert.equal(
        isToggleExplorerShortcut(
          shortcut(primary),
          platform === 'macOS',
          false,
        ),
        false,
      );
      assert.equal(
        isToggleVaultsShortcut(
          shortcut({ ...primary, shiftKey: true }),
          platform === 'macOS',
          false,
        ),
        false,
      );
      assert.equal(
        isToggleExplorerShortcut(
          shortcut({ ...primary, altKey: true }),
          platform === 'macOS',
          true,
        ),
        false,
      );
      assert.equal(
        isToggleVaultsShortcut(
          shortcut({ ...primary, shiftKey: true, altKey: true }),
          platform === 'macOS',
          true,
        ),
        false,
      );
    });
  }
});

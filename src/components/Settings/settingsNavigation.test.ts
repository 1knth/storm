import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isAppearanceCategory,
  nextSettingsCategory,
  resolveSettingsCategory,
  settingsCategories,
  settingsSections,
} from './settingsNavigation';

test('the rail lists General before Appearance', () => {
  assert.deepEqual(
    settingsSections({ cliAvailable: false }).map((section) => section.title),
    ['General', 'Appearance'],
  );
});

test('the command line category appears only when the CLI is available', () => {
  const withoutCli = settingsCategories({ cliAvailable: false }).map(
    (category) => category.id,
  );
  const withCli = settingsCategories({ cliAvailable: true }).map(
    (category) => category.id,
  );
  assert.ok(!withoutCli.includes('cli'));
  assert.ok(withCli.includes('cli'));
  assert.equal(withCli.length, withoutCli.length + 1);
});

test('every category has a label and a summary', () => {
  for (const category of settingsCategories({ cliAvailable: true })) {
    assert.ok(category.label.length > 0, `${category.id} needs a label`);
    assert.ok(category.summary.length > 0, `${category.id} needs a summary`);
  }
});

test('resolveSettingsCategory falls back when a category is unavailable', () => {
  const available = settingsCategories({ cliAvailable: false });
  assert.equal(resolveSettingsCategory('charts', available).id, 'charts');
  assert.equal(resolveSettingsCategory('cli', available).id, 'vaults');
});

test('isAppearanceCategory separates appearance panes from general ones', () => {
  assert.equal(isAppearanceCategory('preview'), true);
  assert.equal(isAppearanceCategory('charts'), true);
  assert.equal(isAppearanceCategory('vaults'), false);
  assert.equal(isAppearanceCategory('cli'), false);
});

test('arrow keys walk the rail and clamp at both ends', () => {
  const available = settingsCategories({ cliAvailable: false });
  const first = available[0].id;
  const last = available[available.length - 1].id;
  assert.equal(nextSettingsCategory('ArrowDown', first, available), 'editor');
  assert.equal(nextSettingsCategory('ArrowUp', first, available), first);
  assert.equal(nextSettingsCategory('ArrowDown', last, available), last);
  assert.equal(nextSettingsCategory('Home', last, available), first);
  assert.equal(nextSettingsCategory('End', first, available), last);
  assert.equal(nextSettingsCategory('Enter', first, available), null);
});

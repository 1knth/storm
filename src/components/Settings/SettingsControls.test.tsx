import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ColorRow,
  Keys,
  SettingsGroup,
  SettingsRow,
  SettingsToggleRow,
  ThemeColorRow,
} from './SettingsControls';

test('SettingsRow labels its control when given a target id', () => {
  const markup = renderToStaticMarkup(
    <SettingsRow label="Vault folder" hint="/vault" htmlFor="vault-field">
      <button type="button">Change vault</button>
    </SettingsRow>,
  );
  assert.match(
    markup,
    /<label[^>]*for="vault-field"[^>]*>Vault folder<\/label>/,
  );
  assert.match(markup, /\/vault/);
});

test('SettingsRow without a target id renders a plain label', () => {
  const markup = renderToStaticMarkup(
    <SettingsRow label="Open settings" hint="Always on" />,
  );
  assert.ok(!markup.includes('<label'));
  assert.match(markup, /Open settings/);
});

test('SettingsToggleRow renders a checkbox that reflects its state', () => {
  const on = renderToStaticMarkup(
    <SettingsToggleRow
      label="Vim keybindings"
      hint="Use Esc for normal mode and i to insert."
      checked
      onChange={() => {}}
    />,
  );
  assert.match(on, /type="checkbox"/);
  assert.match(on, /checked/);
  assert.match(on, /Vim keybindings/);

  const off = renderToStaticMarkup(
    <SettingsToggleRow label="Open file" checked={false} onChange={() => {}} />,
  );
  assert.ok(!off.includes('checked'));
});

test('Keys renders one keycap per key in the chord', () => {
  const markup = renderToStaticMarkup(<Keys chord="⌘ ⇧ S" />);
  assert.equal(markup.match(/<kbd/g)?.length, 3);
  assert.match(markup, /<kbd[^>]*>⌘<\/kbd>/);
  assert.match(markup, /<kbd[^>]*>S<\/kbd>/);
});

test('ColorRow pairs a labelled swatch with an opacity field', () => {
  const markup = renderToStaticMarkup(
    <ColorRow
      label="Selection highlight"
      colorKey="selection"
      value="#e0bfff"
      opacity={40}
      onColorChange={() => {}}
      onOpacityChange={() => {}}
    />,
  );
  assert.match(markup, /id="appearance-selection"/);
  assert.match(markup, /type="color"/);
  assert.match(markup, /value="#e0bfff"/);
  assert.match(markup, /aria-label="Selection highlight opacity"/);
  assert.match(markup, /value="40"/);
});

test('ColorRow omits the opacity field for colors without one', () => {
  const markup = renderToStaticMarkup(
    <ColorRow
      label="Folder icons"
      colorKey="folderIcon"
      value="#9EE4FF"
      opacity={null}
      onColorChange={() => {}}
      onOpacityChange={() => {}}
    />,
  );
  assert.match(markup, /id="appearance-folderIcon"/);
  assert.ok(!markup.includes('opacity"'));
  assert.ok(!markup.includes('undefined'));
});

test('ThemeColorRow disables the reset button only when already on theme', () => {
  const chosen = renderToStaticMarkup(
    <ThemeColorRow
      label="Bold text"
      colorKey="previewBoldColor"
      value="#ff8800"
      onChange={() => {}}
    />,
  );
  assert.match(chosen, /value="#ff8800"/);
  assert.ok(!chosen.includes('disabled'));

  const themed = renderToStaticMarkup(
    <ThemeColorRow
      label="Bold text"
      colorKey="previewBoldColor"
      value={null}
      onChange={() => {}}
    />,
  );
  assert.match(themed, /value="#ffffff"/);
  assert.match(themed, /disabled/);
  assert.match(themed, /Use theme default/);
});

test('SettingsGroup renders its title and note above its rows', () => {
  const markup = renderToStaticMarkup(
    <SettingsGroup
      title="Emphasis colors"
      note="These colors affect the rendered preview only."
    >
      <SettingsRow label="Bold text" />
    </SettingsGroup>,
  );
  assert.ok(
    markup.indexOf('Emphasis colors') <
      markup.indexOf('These colors affect the rendered preview only.'),
  );
  assert.ok(markup.indexOf('These colors') < markup.indexOf('Bold text'));
});

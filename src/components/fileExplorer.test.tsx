import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import FileExplorer from './fileExplorer';
import { DEFAULT_APPEARANCE } from '../appearance';

function renderExplorer() {
  return renderToStaticMarkup(
    <FileExplorer
      onNoteSelect={() => {}}
      onImageSelect={() => {}}
      onPdfSelect={() => {}}
      vaultId="vault-1"
      onCreate={() => {}}
      onCreateNote={() => {}}
      onRenameEntry={async () => {}}
      creationPending={false}
      onAddVault={() => {}}
      onUnloadAllVaults={async () => true}
      vaultCount={1}
      vaultPath="/vault"
      notes={[]}
      loading={false}
      error={null}
      vimMode={false}
      onVimModeChange={() => {}}
      settingsOpen={false}
      onSettingsOpenChange={() => {}}
      openFileShortcut={false}
      onOpenFileShortcutChange={() => {}}
      toggleExplorerShortcut={false}
      commandHeld={false}
      onToggleExplorerShortcutChange={() => {}}
      selectedPath={null}
      collapsed={false}
      onToggleCollapsed={() => {}}
      onCopyPathError={() => {}}
      onPathCopied={() => {}}
      appearance={DEFAULT_APPEARANCE}
      onAppearanceChange={() => {}}
    />,
  );
}

test('Directory header button renders the copy and Command-click affordance', () => {
  const markup = renderExplorer();
  assert.match(
    markup,
    /aria-label="Copy vault path; Command-click to open directory"/,
  );
  assert.match(
    markup,
    /title="Copy path: \/vault\nCommand-click to open directory in Finder"/,
  );
});

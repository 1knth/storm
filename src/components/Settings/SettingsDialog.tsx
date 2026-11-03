import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DEFAULT_APPEARANCE } from '../../appearance';
import type { Appearance } from '../../appearance';
import {
  appearanceColor,
  chartColorGroups,
  diagramColorGroups,
  editorColorGroups,
  hasAppearanceOpacity,
  PREVIEW_EMPHASIS_ROWS,
  withAppearanceColor,
  withAppearanceOpacity,
} from './appearanceSettings';
import type { AppearanceColorGroup } from './appearanceSettings';
import {
  isAppearanceCategory,
  nextSettingsCategory,
  resolveSettingsCategory,
  settingsCategories,
  settingsSections,
} from './settingsNavigation';
import type { SettingsCategoryId } from './settingsNavigation';
import {
  ColorRow,
  Keys,
  SettingsGroup,
  SettingsRow,
  SettingsToggleRow,
  ThemeColorRow,
} from './SettingsControls';
import './settings.css';

const PANE_HEADING_ID = 'settings-pane-heading';

/** Shortcut keycaps name the keys this platform actually uses. */
function shortcutChords() {
  const mac =
    typeof navigator !== 'undefined' &&
    navigator.platform.toLowerCase().includes('mac');
  return {
    openFile: mac ? '⌘ P' : 'Ctrl P',
    toggleExplorer: mac ? '⌘ S' : 'Ctrl S',
    toggleVaults: mac ? '⌘ ⇧ S' : 'Ctrl Shift S',
    openSettings: mac ? '⌘ ,' : 'Ctrl ,',
  };
}

export type SettingsDialogProps = {
  onClose: () => void;
  vaultPath: string | null;
  vaultCount: number;
  loading: boolean;
  onAddVault: () => void;
  onUnloadAllVaults: () => Promise<boolean>;
  vimMode: boolean;
  onVimModeChange: (enabled: boolean) => void;
  openFileShortcut: boolean;
  onOpenFileShortcutChange: (enabled: boolean) => void;
  toggleExplorerShortcut: boolean;
  onToggleExplorerShortcutChange: (enabled: boolean) => void;
  toggleVaultsShortcut: boolean;
  onToggleVaultsShortcutChange: (enabled: boolean) => void;
  appearance: Appearance;
  onAppearanceChange: (appearance: Appearance) => void;
};

export default function SettingsDialog({
  onClose,
  vaultPath,
  vaultCount,
  loading,
  onAddVault,
  onUnloadAllVaults,
  vimMode,
  onVimModeChange,
  openFileShortcut,
  onOpenFileShortcutChange,
  toggleExplorerShortcut,
  onToggleExplorerShortcutChange,
  toggleVaultsShortcut,
  onToggleVaultsShortcutChange,
  appearance,
  onAppearanceChange,
}: SettingsDialogProps) {
  const changeVaultRef = useRef<HTMLButtonElement>(null);
  const [requestedCategory, setRequestedCategory] =
    useState<SettingsCategoryId>('vaults');
  const [confirmUnload, setConfirmUnload] = useState(false);
  const [unloading, setUnloading] = useState(false);
  const [cliAvailable, setCliAvailable] = useState(false);
  const [cliInstalled, setCliInstalled] = useState(false);
  const [cliBusy, setCliBusy] = useState(false);
  const [canOpenFilesAndFoldersSettings, setCanOpenFilesAndFoldersSettings] =
    useState(false);

  const sections = settingsSections({ cliAvailable });
  const categories = settingsCategories({ cliAvailable });
  const category = resolveSettingsCategory(requestedCategory, categories);
  const chords = shortcutChords();

  useEffect(() => {
    void window.vault.cliAvailable().then(setCliAvailable);
    void window.vault.cliInstalled().then(setCliInstalled);
    void window.vault
      .canOpenFilesAndFoldersSettings()
      .then(setCanOpenFilesAndFoldersSettings);
  }, []);

  useEffect(() => changeVaultRef.current?.focus(), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || unloading) return;
      if (confirmUnload) setConfirmUnload(false);
      else onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [confirmUnload, onClose, unloading]);

  const selectCategory = (id: SettingsCategoryId) => {
    setConfirmUnload(false);
    setRequestedCategory(id);
  };

  const colorGroups = (groups: AppearanceColorGroup[]) =>
    groups.map((group) => (
      <SettingsGroup key={group.title} title={group.title}>
        {group.rows.map((row) => (
          <ColorRow
            key={row.key}
            label={row.label}
            colorKey={row.key}
            value={appearanceColor(appearance, row.key)}
            opacity={
              hasAppearanceOpacity(appearance, row.key)
                ? appearance.opacity[row.key]
                : null
            }
            onColorChange={(color) =>
              onAppearanceChange(
                withAppearanceColor(appearance, row.key, color),
              )
            }
            onOpacityChange={(opacity) =>
              onAppearanceChange(
                withAppearanceOpacity(appearance, row.key, opacity),
              )
            }
          />
        ))}
      </SettingsGroup>
    ));

  return createPortal(
    <div
      className="settings-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !unloading) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="settings-window"
      >
        <header className="settings-titlebar">
          <h2 id="settings-title">Settings</h2>
          <button
            type="button"
            aria-label="Close settings"
            disabled={unloading}
            onClick={onClose}
            className="app-icon-button settings-close"
          >
            ×
          </button>
        </header>

        <div className="settings-body">
          <nav
            aria-label="Settings categories"
            className="settings-rail"
            onKeyDown={(event) => {
              const next = nextSettingsCategory(
                event.key,
                category.id,
                categories,
              );
              if (!next) return;
              event.preventDefault();
              selectCategory(next);
              event.currentTarget
                .querySelector<HTMLButtonElement>(`[data-category="${next}"]`)
                ?.focus();
            }}
          >
            {sections.map((section) => (
              <div key={section.title} className="settings-rail-group">
                <h3 className="settings-rail-title">{section.title}</h3>
                {section.categories.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    data-category={entry.id}
                    aria-current={entry.id === category.id ? 'true' : undefined}
                    tabIndex={entry.id === category.id ? 0 : -1}
                    onClick={() => selectCategory(entry.id)}
                    className="settings-rail-item"
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
            ))}
          </nav>

          <div
            className="settings-pane"
            role="region"
            aria-labelledby={PANE_HEADING_ID}
            tabIndex={-1}
          >
            <div className="settings-pane-header">
              <h3 id={PANE_HEADING_ID}>{category.label}</h3>
              <p>{category.summary}</p>
            </div>

            {category.id === 'vaults' && (
              <>
                {confirmUnload && (
                  <div
                    className="settings-alert"
                    role="alertdialog"
                    aria-labelledby="unload-title"
                    aria-describedby="unload-description"
                  >
                    <h4 id="unload-title">Unload all vaults?</h4>
                    <p id="unload-description">
                      This closes all vaults and tabs and clears saved vault
                      registrations, groups, and tab layouts. It does not delete
                      or modify any folders or notes.
                    </p>
                    <div className="settings-alert-actions">
                      <button
                        type="button"
                        disabled={unloading}
                        onClick={() => setConfirmUnload(false)}
                        className="settings-button settings-button--quiet"
                      >
                        Cancel
                      </button>
                      <button
                        autoFocus
                        type="button"
                        disabled={unloading}
                        onClick={async () => {
                          setUnloading(true);
                          try {
                            const unloaded = await onUnloadAllVaults();
                            if (unloaded) {
                              setConfirmUnload(false);
                              onClose();
                            }
                          } finally {
                            setUnloading(false);
                          }
                        }}
                        className="settings-button settings-button--danger"
                      >
                        {unloading ? 'Unloading…' : 'Unload all vaults'}
                      </button>
                    </div>
                  </div>
                )}
                <SettingsGroup>
                  <SettingsRow
                    label="Vault folder"
                    hint={vaultPath ?? 'No vault selected'}
                    hintClassName="settings-row-hint--path"
                  >
                    <button
                      ref={changeVaultRef}
                      type="button"
                      onClick={() => {
                        onAddVault();
                        onClose();
                      }}
                      disabled={loading}
                      className="settings-button"
                    >
                      Change vault
                    </button>
                  </SettingsRow>
                  <SettingsRow
                    label="Folder access"
                    hint="If access failed, choose that folder again. macOS controls Files & Folders prompts; Storm cannot force one to appear."
                  >
                    <button
                      type="button"
                      onClick={onAddVault}
                      disabled={loading}
                      title="Choose the vault folder again to request access. macOS controls any Files & Folders prompts."
                      className="settings-button"
                    >
                      Request folder access…
                    </button>
                  </SettingsRow>
                  {canOpenFilesAndFoldersSettings && (
                    <SettingsRow
                      label="Still blocked?"
                      hint="Check whether Storm is allowed in macOS privacy settings."
                    >
                      <button
                        type="button"
                        onClick={() =>
                          void window.vault
                            .openFilesAndFoldersSettings()
                            .catch((error: unknown) =>
                              console.error(
                                'Could not open Files & Folders settings',
                                error,
                              ),
                            )
                        }
                        className="settings-button"
                      >
                        Open Files &amp; Folders settings
                      </button>
                    </SettingsRow>
                  )}
                  <SettingsRow
                    label="Unload all vaults"
                    hint="Closes every vault and tab and clears saved registrations, groups, and tab layouts. Folders and notes are left alone."
                  >
                    <button
                      type="button"
                      disabled={vaultCount === 0 || unloading}
                      onClick={() => setConfirmUnload(true)}
                      className="settings-button settings-button--danger"
                    >
                      Unload all vaults…
                    </button>
                  </SettingsRow>
                </SettingsGroup>
              </>
            )}

            {category.id === 'editor' && (
              <SettingsGroup>
                <SettingsToggleRow
                  label="Vim keybindings"
                  hint="Use Esc for normal mode and i to insert."
                  checked={vimMode}
                  onChange={onVimModeChange}
                />
              </SettingsGroup>
            )}

            {category.id === 'shortcuts' && (
              <SettingsGroup>
                <SettingsToggleRow
                  label="Open file"
                  hint={<Keys chord={chords.openFile} />}
                  checked={openFileShortcut}
                  onChange={onOpenFileShortcutChange}
                />
                <SettingsToggleRow
                  label="Toggle file explorer"
                  hint={<Keys chord={chords.toggleExplorer} />}
                  checked={toggleExplorerShortcut}
                  onChange={onToggleExplorerShortcutChange}
                />
                <SettingsToggleRow
                  label="Toggle vault sidebar"
                  hint={<Keys chord={chords.toggleVaults} />}
                  checked={toggleVaultsShortcut}
                  onChange={onToggleVaultsShortcutChange}
                />
                <SettingsRow label="Open settings" hint="Always on">
                  <Keys chord={chords.openSettings} />
                </SettingsRow>
              </SettingsGroup>
            )}

            {category.id === 'cli' && (
              <SettingsGroup>
                <SettingsRow
                  label="Storm CLI"
                  hint="Create a terminal command shortcut for the bundled CLI."
                >
                  <button
                    type="button"
                    disabled={cliBusy}
                    onClick={() => {
                      setCliBusy(true);
                      const operation = cliInstalled
                        ? window.vault.disableCli()
                        : window.vault.enableCli();
                      void operation
                        .then(setCliInstalled)
                        .catch((error: unknown) =>
                          console.error(
                            'Could not change Storm CLI state',
                            error,
                          ),
                        )
                        .finally(() => {
                          void window.vault
                            .cliInstalled()
                            .then(setCliInstalled)
                            .catch((error: unknown) =>
                              console.error(
                                'Could not refresh Storm CLI state',
                                error,
                              ),
                            )
                            .finally(() => setCliBusy(false));
                        });
                    }}
                    className="settings-button"
                  >
                    {cliInstalled ? 'Disable' : 'Enable'}
                  </button>
                </SettingsRow>
              </SettingsGroup>
            )}

            {category.id === 'preview' && (
              <>
                <SettingsGroup title="Heading spacing">
                  <div className="settings-row settings-row--stacked">
                    <span className="settings-slider-head">
                      <label
                        className="settings-row-label"
                        htmlFor="appearance-heading-spacing"
                      >
                        Space above and below headings
                      </label>
                      <span className="settings-value">
                        {appearance.previewHeadingSpacing}%
                      </span>
                    </span>
                    <input
                      id="appearance-heading-spacing"
                      type="range"
                      min={0}
                      max={200}
                      step={5}
                      value={appearance.previewHeadingSpacing}
                      aria-valuetext={`${appearance.previewHeadingSpacing}%`}
                      onChange={(event) =>
                        onAppearanceChange({
                          ...appearance,
                          previewHeadingSpacing: Number(event.target.value),
                        })
                      }
                      className="settings-slider"
                    />
                    <span className="settings-row-hint">
                      100% keeps the default spacing.
                    </span>
                  </div>
                </SettingsGroup>
                <SettingsGroup
                  title="Emphasis colors"
                  note="These colors affect the rendered preview only."
                >
                  {PREVIEW_EMPHASIS_ROWS.map((row) => (
                    <ThemeColorRow
                      key={row.key}
                      label={row.label}
                      colorKey={row.key}
                      value={appearance[row.key]}
                      onChange={(color) =>
                        onAppearanceChange({ ...appearance, [row.key]: color })
                      }
                    />
                  ))}
                </SettingsGroup>
              </>
            )}

            {category.id === 'editorColors' &&
              colorGroups(editorColorGroups(appearance))}
            {category.id === 'diagrams' && colorGroups(diagramColorGroups())}
            {category.id === 'charts' &&
              colorGroups(chartColorGroups(appearance))}
          </div>
        </div>

        {isAppearanceCategory(category.id) && (
          <footer className="settings-footer">
            <span className="settings-footer-note">
              Appearance changes apply as you make them.
            </span>
            <button
              type="button"
              onClick={() => onAppearanceChange(DEFAULT_APPEARANCE)}
              className="settings-button"
            >
              Reset appearance
            </button>
          </footer>
        )}
      </section>
    </div>,
    document.body,
  );
}

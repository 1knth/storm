export type SettingsCategoryId =
  | 'vaults'
  | 'cli'
  | 'editor'
  | 'shortcuts'
  | 'preview'
  | 'editorColors'
  | 'diagrams'
  | 'charts';

export type SettingsCategory = {
  id: SettingsCategoryId;
  /** Rail entry and pane heading. */
  label: string;
  /** One line under the pane heading saying what the pane changes. */
  summary: string;
};

export type SettingsSection = {
  title: string;
  categories: SettingsCategory[];
};

const APPEARANCE_CATEGORIES: SettingsCategoryId[] = [
  'preview',
  'editorColors',
  'diagrams',
  'charts',
];

/**
 * The rail lists every category in a fixed order. The command-line category
 * only appears when the packaged CLI is available to install.
 */
export function settingsSections(options: {
  cliAvailable: boolean;
}): SettingsSection[] {
  return [
    {
      title: 'General',
      categories: [
        {
          id: 'vaults',
          label: 'Vaults',
          summary: 'Choose the vault folder, grant access, or start over.',
        },
        {
          id: 'editor',
          label: 'Editor',
          summary: 'How typing and editing behave.',
        },
        {
          id: 'shortcuts',
          label: 'Shortcuts',
          summary: 'Turn application keyboard shortcuts on or off.',
        },
        ...(options.cliAvailable
          ? [
              {
                id: 'cli' as const,
                label: 'Command line',
                summary: 'Run Storm from a terminal.',
              },
            ]
          : []),
      ],
    },
    {
      title: 'Appearance',
      categories: [
        {
          id: 'preview',
          label: 'Preview',
          summary: 'Spacing and emphasis colors in the rendered preview.',
        },
        {
          id: 'editorColors',
          label: 'Editor colors',
          summary: 'Highlights, cursor, icons, and heading colors.',
        },
        {
          id: 'diagrams',
          label: 'Diagrams',
          summary: 'Mermaid canvas, nodes, and connectors.',
        },
        {
          id: 'charts',
          label: 'Charts',
          summary: 'Chart labels, grid lines, and series colors.',
        },
      ],
    },
  ];
}

export function settingsCategories(options: {
  cliAvailable: boolean;
}): SettingsCategory[] {
  return settingsSections(options).flatMap((section) => section.categories);
}

export function isAppearanceCategory(id: SettingsCategoryId): boolean {
  return APPEARANCE_CATEGORIES.includes(id);
}

/**
 * Keeps a selection valid when the available categories change, so the rail
 * and the open pane can never disagree.
 */
export function resolveSettingsCategory(
  requested: SettingsCategoryId,
  available: SettingsCategory[],
): SettingsCategory {
  return (
    available.find((category) => category.id === requested) ?? available[0]
  );
}

/** Arrow, Home, and End keys move the rail selection like a macOS sidebar. */
export function nextSettingsCategory(
  key: string,
  current: SettingsCategoryId,
  available: SettingsCategory[],
): SettingsCategoryId | null {
  const index = available.findIndex((category) => category.id === current);
  if (index < 0) return null;
  if (key === 'ArrowDown')
    return available[Math.min(index + 1, available.length - 1)].id;
  if (key === 'ArrowUp') return available[Math.max(index - 1, 0)].id;
  if (key === 'Home') return available[0].id;
  if (key === 'End') return available[available.length - 1].id;
  return null;
}

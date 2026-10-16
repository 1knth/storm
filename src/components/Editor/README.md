# Markdown editor behavior

The editor uses CodeMirror's standard history and key bindings, plus Markdown-aware Enter behavior. The extension bundle lives in `extensions.ts` so the behavior stays separate from React/DOM lifecycle and autosave handling.

- **Undo / redo:** `Cmd+Z` / `Cmd+Shift+Z` on macOS; `Ctrl+Z` / `Ctrl+Shift+Z` elsewhere. CodeMirror history is local to the current editor session and is not persisted across reloads.
- **Enter:** continues Markdown list, task-list, and blockquote markup where applicable; Enter twice exits an empty item where CodeMirror supports it.
- **Tab / Shift+Tab:** indent / outdent the selected lines by two spaces. In a code fence or other Markdown language region, CodeMirror's indentation rules can apply on input.
- **Long lines:** wrap in the editor rather than requiring horizontal scrolling.

Each open note has its own in-memory CodeMirror `EditorState`, preserving document, selection, scroll position, and undo history while switching readable tabs. Tabs are session-only. The active note keeps the existing debounced autosave and flush-before-switch behavior; inactive notes are not independently autosaved. Vim mode is reconfigured on each restored state.

## Window layout

The renderer reserves a 36px draggable titlebar strip above both panes for the macOS traffic lights. The explorer and editor share the remaining row height and use matching 16px insets; their height follows the flex layout rather than separate viewport calculations. The editor card has zero inner padding, and the tab strip remains a separate, square-edged row above it.

The repository does not currently define a dedicated renderer-only build or editor test script. Verify the editor manually after restarting the app or allowing the renderer to hot-reload.

import React, { useEffect, useRef, useState } from 'react';
import './index.css';
import { createRoot } from 'react-dom/client';
import FileExplorer from './components/fileExplorer';
import VaultSidebar from './components/VaultSidebar';
import type {
  RegisteredVault,
  SidebarRootRef,
  VaultEntry,
  VaultGroup,
} from './shared/types';
import { deriveVisibleVaults } from './shared/vaultGroups';
import Editor from './components/Editor/Editor';
import FilePicker from './components/FilePicker';
import { filterPickerEntries } from './components/filePickerEntries';
import type { EditorHandle, TabSnapshot } from './components/Editor/Editor';
import TabBar from './components/Editor/TabBar';
import {
  cleanTabAssignments,
  normalizeTabGroupState,
  getTabId,
  hasOpenTabs,
  moveTab,
  moveTabGroupBlock,
  visibleTabOrder,
} from './components/Editor/tabGroups';
import type { TabAssignments, TabGroup } from './components/Editor/tabGroups';
import { closeTabTransition } from './components/Editor/tabTransitions';
import { serializeTabLayout } from './components/Editor/savedTabLayout';
import { checkpointErrorMessage } from './components/Editor/checkpointError';
import { ToastProvider, useToast } from './components/Toast';
import { loadAppearance, saveAppearance } from './appearance';
import type { Appearance } from './appearance';
import { createAgentDocumentHost } from './documents/agentDocumentHost';
import { isAgentTabProtected } from './documents/agentTabProtection';
import {
  STARTUP_VAULT_ERROR,
  shouldNotifyVaultError,
} from './startupVaultError';
import {
  coordinateRename,
  remapRenamedTabAssignments,
  remapRenamedTabs,
} from './vault/renameCoordinator';

function ShortcutGroup({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-white/50">
        {title}
      </h3>
      <ul className="space-y-2 text-sm">
        {items.map((item) => (
          <li key={item} className="text-white/85">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

const isEligibleFocusTarget = (
  element: HTMLElement | null,
): element is HTMLElement => {
  if (!element?.isConnected || element.matches(':disabled')) return false;
  if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  if (element.getClientRects().length === 0) return false;
  const style = window.getComputedStyle(element);
  return style.visibility !== 'hidden' && style.visibility !== 'collapse';
};

const hasOpenModal = () =>
  Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role="dialog"][aria-modal="true"]',
    ),
  ).some((dialog) => isEligibleFocusTarget(dialog));

function App() {
  const { notifyError, notifySuccess } = useToast();
  const editorRef = useRef<EditorHandle>(null);
  const [readingModes, setReadingModes] = useState<Record<string, boolean>>({});
  const [appearance, setAppearance] = useState<Appearance>(() =>
    loadAppearance(window.localStorage),
  );
  useEffect(() => {
    saveAppearance(window.localStorage, appearance);
  }, [appearance]);
  const agentHost = useRef<ReturnType<typeof createAgentDocumentHost> | null>(
    null,
  );
  const navigationBusy = useRef(false);
  const vaultTransition = useRef(false);
  const noteRequestId = useRef(0);
  const visitedVaults = useRef(new Set<string>());
  const checkpointTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const checkpointInFlight = useRef<Promise<void> | null>(null);
  const lastCheckpointError = useRef<string | null>(null);
  const sessions = useRef(
    new Map<
      string,
      {
        tabs: TabSnapshot[];
        activeId: string | null;
        groups: TabGroup[];
        assignments: TabAssignments;
      }
    >(),
  );
  const [tabGroups, setTabGroups] = useState<TabGroup[]>([]);
  const [tabGroupAssignments, setTabGroupAssignments] =
    useState<TabAssignments>({});
  const [tabs, setTabs] = useState<TabSnapshot[]>([]);
  const [renameInProgress, setRenameInProgress] = useState(false);
  const renameInProgressRef = useRef(false);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [vaultPath, setVaultPath] = useState<string | null>(null);
  const [vaults, setVaults] = useState<RegisteredVault[]>([]);
  const [vaultGroups, setVaultGroups] = useState<VaultGroup[]>([]);
  const [sidebarRootOrder, setSidebarRootOrder] = useState<SidebarRootRef[]>(
    [],
  );
  const visibleVaults = deriveVisibleVaults(
    vaults,
    vaultGroups,
    sidebarRootOrder,
  );
  const [activeVaultId, setActiveVaultId] = useState<string | null>(null);
  const readingModeKey =
    activeVaultId && activePath
      ? JSON.stringify([activeVaultId, activePath])
      : null;
  const readingMode = readingModeKey
    ? readingModes[readingModeKey] === true
    : false;
  const activeVaultIdRef = useRef<string | null>(null);
  const tabsRef = useRef(tabs);
  const activeIdRef = useRef(activeId);
  const groupsRef = useRef(tabGroups);
  const assignmentsRef = useRef(tabGroupAssignments);
  activeVaultIdRef.current = activeVaultId;
  tabsRef.current = tabs;
  activeIdRef.current = activeId;
  groupsRef.current = tabGroups;
  assignmentsRef.current = tabGroupAssignments;

  useEffect(() => {
    const host = createAgentDocumentHost({
      lookupDocument: ({ vaultId, path }) => {
        const tab = tabsRef.current.find(
          (candidate) =>
            candidate.kind === 'note' &&
            candidate.vaultId === vaultId &&
            candidate.note.path === path,
        );
        if (!tab || tab.kind !== 'note') return undefined;
        const live = editorRef.current?.snapshot();
        const snapshot =
          live?.vaultId === vaultId && live.note.path === path ? live : tab;
        return {
          key: `${vaultId}:${path}`,
          vaultId,
          absolutePath: `${tab.vaultPath}/${path}`,
          vaultPath: tab.vaultPath,
          path,
          state: snapshot.state,
          revision: snapshot.note.revision,
        };
      },
      openDocument: async ({ absolutePath, vaultId, vaultRoot }) => {
        const relativePath = absolutePath
          .slice(vaultRoot.length)
          .replace(/^[\\/]+/, '')
          .replace(/\\/g, '/');
        if (!relativePath || relativePath.startsWith('..'))
          throw new Error('Agent target is outside its vault');
        if (vaultId !== activeVaultIdRef.current) {
          const activated = await activateVault(vaultId);
          if (!activated)
            throw new Error('Could not safely activate the target vault');
        }
        const opened = await window.vault.readNote(relativePath);
        const note = { ...opened, path: relativePath };
        let target = tabsRef.current.find(
          (tab) =>
            tab.kind === 'note' &&
            tab.vaultId === vaultId &&
            tab.note.path === relativePath,
        );
        if (!target || target.kind !== 'note') {
          if (!(await editorRef.current?.flush()))
            throw new Error(
              'Could not save the active note before opening the agent target',
            );
          const outgoing = editorRef.current?.snapshot();
          let currentTabs = tabsRef.current;
          if (outgoing)
            currentTabs = currentTabs.map((tab) =>
              tab.kind === 'note' && tab.note.path === outgoing.note.path
                ? outgoing
                : tab,
            );
          const state = editorRef.current!.createState(note.content);
          target = {
            kind: 'note',
            note,
            vaultId,
            vaultPath: vaultRoot,
            state,
            scrollTop: 0,
          };
          currentTabs = [...currentTabs, target];
          tabsRef.current = currentTabs;
          setTabs(currentTabs);
          activeIdRef.current = getTabId(target);
          setActiveId(activeIdRef.current);
          setActivePath(relativePath);
        }
        if (target.kind !== 'note')
          throw new Error('Agent target is not a note');
        const live = editorRef.current?.snapshot();
        let snapshot: Extract<TabSnapshot, { kind: 'note' }>;
        if (live?.note.path === relativePath && live.vaultId === vaultId) {
          snapshot = live;
        } else {
          if (!(await editorRef.current?.flush()))
            throw new Error(
              'Could not save the active note before opening the agent target',
            );
          let currentTabs = tabsRef.current;
          if (live)
            currentTabs = currentTabs.map((tab) =>
              tab.kind === 'note' &&
              tab.vaultId === live.vaultId &&
              tab.note.path === live.note.path
                ? live
                : tab,
            );
          tabsRef.current = currentTabs;
          if (live) setTabs(currentTabs);
          const currentTarget = currentTabs.find(
            (tab) =>
              tab.kind === 'note' &&
              tab.vaultId === vaultId &&
              tab.note.path === relativePath,
          );
          if (!currentTarget || currentTarget.kind !== 'note')
            throw new Error('Agent target is no longer open');
          editorRef.current?.activate(currentTarget);
          snapshot = editorRef.current?.snapshot() ?? currentTarget;
        }
        activeIdRef.current = getTabId(target);
        setActiveId(activeIdRef.current);
        setActivePath(relativePath);
        return {
          key: `${vaultId}:${relativePath}`,
          vaultId,
          absolutePath,
          vaultPath: vaultRoot,
          path: relativePath,
          state: snapshot.state,
          revision: snapshot.note.revision,
        };
      },
      publishDocument: (document) => {
        if (!document.vaultId) return;
        setAgentDocumentVersion((version) => version + 1);
        const adapter = {
          vaultId: document.vaultId,
          path: document.path,
          writing: document.status === 'writing',
          revision: document.revision,
          onStateChange: (state: import('@codemirror/state').EditorState) =>
            host.controller.updateFromEditor(document.key, state),
          flush: () => host.controller.flush(document),
        };
        agentAdaptersRef.current.set(
          JSON.stringify([adapter.vaultId, adapter.path]),
          adapter,
        );
        if (
          adapter?.vaultId === document.vaultId &&
          adapter.path === document.path
        ) {
          editorRef.current?.syncManagedState(
            document.vaultId,
            document.path,
            document.state,
          );
        }
        setTabs((current) =>
          current.map((tab) =>
            tab.kind === 'note' &&
            tab.vaultId === document.vaultId &&
            tab.note.path === document.path
              ? { ...tab, state: document.state }
              : tab,
          ),
        );
      },
      publishStatus: (event) =>
        setAgentStatuses((current) => ({
          ...current,
          [event.session.sessionId]: event.session,
        })),
      saveNote: (request) => window.stormAgent.saveNote(request),
      getAdapterFor: (vaultId, path) =>
        agentAdaptersRef.current.get(JSON.stringify([vaultId, path])),
    });
    agentHost.current = host;
    const unsubscribe = window.stormAgent.onRequest((request) => {
      void host
        .handleRequest(request)
        .then((result) => window.stormAgent.respond(request.requestId, result));
    });
    const unsubscribeStatus = window.stormAgent.onStatus((event) =>
      setAgentStatuses((current) => ({
        ...current,
        [event.session.sessionId]: event.session,
      })),
    );
    return () => {
      unsubscribe();
      unsubscribeStatus();
      host.dispose();
      agentHost.current = null;
    };
  }, []);
  const agentAdaptersRef = useRef(
    new Map<
      string,
      import('./components/Editor/agentEditorAdapter').AgentEditorAdapter
    >(),
  );
  const [agentStatuses, setAgentStatuses] = useState<
    Record<string, import('./shared/agentProtocol').AgentSessionStatus>
  >({});
  const [, setAgentDocumentVersion] = useState(0);
  const activeAgentAdapter =
    activeVaultId && activePath
      ? (agentAdaptersRef.current.get(
          JSON.stringify([activeVaultId, activePath]),
        ) ?? null)
      : null;
  const matchingAgentStatuses = activeAgentAdapter
    ? Object.values(agentStatuses).filter(
        (status) =>
          status.absolutePath.replace(/\\/g, '/') ===
          `${vaultPath}/${activePath}`.replace(/\\/g, '/'),
      )
    : [];
  const activeAgentStatus =
    matchingAgentStatuses.find(
      (status) => status.state === 'writing' || status.state === 'connected',
    ) ?? matchingAgentStatuses.at(-1);

  const scheduleCheckpoint = () => {
    if (checkpointTimer.current) clearTimeout(checkpointTimer.current);
    checkpointTimer.current = setTimeout(() => {
      checkpointTimer.current = null;
      const save = async () => {
        for (const vaultId of visitedVaults.current) {
          const session = sessions.current.get(vaultId);
          if (!session) continue;
          await window.vault.saveTabLayout(
            vaultId,
            serializeTabLayout(
              session.tabs,
              session.activeId,
              session.groups,
              session.assignments,
              new Map(session.tabs.map((tab) => [getTabId(tab), tab])),
            ),
          );
        }
      };
      checkpointInFlight.current = (
        checkpointInFlight.current ?? Promise.resolve()
      )
        .then(save)
        .catch((error) => {
          const message = checkpointErrorMessage(error);
          if (lastCheckpointError.current !== message) {
            lastCheckpointError.current = message;
            setVaultError(message);
          }
        });
    }, 1000);
  };
  const rememberCurrentSession = (vaultId: string) => {
    const latest = editorRef.current?.snapshot();
    const currentTabs = latest
      ? tabsRef.current.map((tab) =>
          tab.kind === 'note' && tab.note.path === latest.note.path
            ? latest
            : tab,
        )
      : tabsRef.current;
    const normalized = normalizeTabGroupState(
      currentTabs,
      groupsRef.current,
      assignmentsRef.current,
    );
    sessions.current.set(vaultId, {
      tabs: currentTabs,
      activeId: currentTabs.some((tab) => getTabId(tab) === activeIdRef.current)
        ? activeIdRef.current
        : null,
      groups: normalized.groups,
      assignments: normalized.assignments,
    });
    scheduleCheckpoint();
  };

  useEffect(() => {
    const vaultId = activeVaultIdRef.current;
    if (vaultId && visitedVaults.current.has(vaultId))
      rememberCurrentSession(vaultId);
  }, [tabs, activeId, tabGroups, tabGroupAssignments]);

  const onMoveTab = (
    vaultId: string,
    tabId: string,
    groupId: string | null,
    beforeTabId: string | null,
  ) => {
    if (!vaultId || activeVaultIdRef.current !== vaultId) return;
    const moved = moveTab(
      tabsRef.current,
      groupsRef.current,
      assignmentsRef.current,
      tabId,
      groupId,
      beforeTabId,
    );
    if (!moved) return;
    visitedVaults.current.add(vaultId);
    tabsRef.current = moved.tabs;
    assignmentsRef.current = moved.assignments;
    setTabs(moved.tabs);
    setTabGroupAssignments(moved.assignments);
    rememberCurrentSession(vaultId);
    if (groupId) {
      const nextGroups = groupsRef.current.map((group) =>
        group.id === groupId && group.collapsed
          ? { ...group, collapsed: false }
          : group,
      );
      groupsRef.current = nextGroups;
      setTabGroups(nextGroups);
    }
  };
  const onMoveGroup = (
    vaultId: string,
    groupId: string,
    before:
      | { type: 'tab'; tabId: string }
      | { type: 'group'; groupId: string }
      | null,
  ) => {
    if (!vaultId || activeVaultIdRef.current !== vaultId) return;
    const nextTabs = moveTabGroupBlock(
      tabsRef.current,
      groupsRef.current,
      assignmentsRef.current,
      groupId,
      before,
    );
    if (!nextTabs) return;
    tabsRef.current = nextTabs;
    setTabs(nextTabs);
    visitedVaults.current.add(vaultId);
    rememberCurrentSession(vaultId);
  };
  const [vaultError, setVaultErrorState] = useState<string | null>(null);
  const vaultErrorRef = useRef<string | null>(null);
  const setVaultError = (message: string | null) => {
    const shouldNotify = shouldNotifyVaultError(vaultErrorRef.current, message);
    if (message && !shouldNotify) return;
    vaultErrorRef.current = message;
    setVaultErrorState(message);
    if (!message) lastCheckpointError.current = null;
    if (shouldNotify) notifyError(message);
  };
  const [entriesLoading, setEntriesLoading] = useState(false);
  const [explorerCollapsed, setExplorerCollapsed] = useState(false);
  const lastPane = useRef<'vaults' | 'explorer' | 'editor'>('editor');
  const lastPaneElement = useRef<HTMLElement | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const shortcutHelpInvoker = useRef<HTMLElement | null>(null);
  const shortcutHelpDialog = useRef<HTMLElement | null>(null);
  const [commandHeld, setCommandHeld] = useState(false);
  const commandHeldRef = useRef(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerSelectionFocus = useRef(false);
  const [query, setQuery] = useState('');
  const [notes, setNotes] = useState<VaultEntry[]>([]);
  const openImagePreview = async (path: string) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId || navigationBusy.current || vaultTransition.current) return;
    const entry = notes.find(
      (item) => item.path === path && item.kind === 'image',
    );
    if (!entry || activeVaultIdRef.current !== vaultId) return;
    navigationBusy.current = true;
    try {
      if (!(await editorRef.current?.flush())) return;
      const outgoing = editorRef.current?.snapshot();
      if (outgoing)
        setTabs((old) =>
          old.map((tab) =>
            tab.kind === 'note' && tab.note.path === outgoing.note.path
              ? outgoing
              : tab,
          ),
        );
      const image: TabSnapshot = {
        kind: 'image',
        vaultId,
        path: entry.path,
        filename: entry.name,
      };
      const imageId = getTabId(image);
      const existing = tabsRef.current.find((tab) => getTabId(tab) === imageId);
      const activeImage = existing ?? image;
      if (!existing) setTabs((old) => [...old, image]);
      editorRef.current?.activate(activeImage);
      setActiveId(imageId);
      setActivePath(null);
    } finally {
      navigationBusy.current = false;
    }
  };
  const notesRefreshRequest = useRef(0);
  const pendingVaultRefresh = useRef<string | null>(null);
  const refreshNotes = async (vaultId: string) => {
    const requestId = ++notesRefreshRequest.current;
    try {
      const listed = await window.vault.listNotes();
      if (
        requestId === notesRefreshRequest.current &&
        activeVaultIdRef.current === vaultId
      )
        setNotes(listed);
    } catch (error) {
      if (
        requestId === notesRefreshRequest.current &&
        activeVaultIdRef.current === vaultId
      )
        setVaultError(
          `Could not refresh the file list: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
  };
  useEffect(() => {
    return window.vault.onVaultChanged(({ vaultId }) => {
      if (activeVaultIdRef.current !== vaultId) return;
      if (vaultTransition.current) {
        pendingVaultRefresh.current = vaultId;
        return;
      }
      void refreshNotes(vaultId);
    });
  }, []);
  const [creation, setCreation] = useState<{
    kind: 'note' | 'folder';
    vaultId: string;
    parent: string;
    vaultName: string;
  } | null>(null);
  const [creationName, setCreationName] = useState('');
  const [creationPending, setCreationPending] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [pickerPreview, setPickerPreview] = useState<{
    path: string;
    markdown: string;
  } | null>(null);
  const [pickerPreviewState, setPickerPreviewState] = useState<
    'loading' | 'error' | null
  >(null);
  const pickerPreviewRequest = useRef(0);
  const pickerInputRef = useRef<HTMLInputElement>(null);
  const pickerInvokerRef = useRef<HTMLElement | null>(null);
  const [vimMode, setVimMode] = useState(() => {
    try {
      return window.localStorage.getItem('storm.vimMode') === 'true';
    } catch {
      return false;
    }
  });
  const [openFileShortcut, setOpenFileShortcut] = useState(() => {
    try {
      return window.localStorage.getItem('storm.shortcut.openFile') !== 'false';
    } catch {
      return true;
    }
  });
  const [toggleExplorerShortcut, setToggleExplorerShortcut] = useState(() => {
    try {
      return (
        window.localStorage.getItem('storm.shortcut.toggleExplorer') !== 'false'
      );
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem('storm.vimMode', String(vimMode));
    } catch {
      /* Optional preference. */
    }
  }, [vimMode]);
  useEffect(() => {
    try {
      window.localStorage.setItem(
        'storm.shortcut.openFile',
        String(openFileShortcut),
      );
      window.localStorage.setItem(
        'storm.shortcut.toggleExplorer',
        String(toggleExplorerShortcut),
      );
    } catch {
      /* Optional preference. */
    }
    window.vault.setShortcutEnabled('openFile', openFileShortcut);
    window.vault.setShortcutEnabled('toggleExplorer', toggleExplorerShortcut);
  }, [openFileShortcut, toggleExplorerShortcut]);
  useEffect(() => {
    let showTimer: ReturnType<typeof setTimeout> | null = null;
    const setHeld = (held: boolean) => {
      commandHeldRef.current = held;
      setCommandHeld(held);
    };
    const updateModifier = (event: KeyboardEvent) => {
      const held = navigator.platform.toLowerCase().includes('mac')
        ? event.metaKey
        : event.ctrlKey;
      if (held) {
        if (!commandHeldRef.current && !showTimer) {
          showTimer = setTimeout(() => {
            showTimer = null;
            setHeld(true);
          }, 650);
        }
      } else {
        if (showTimer) clearTimeout(showTimer);
        showTimer = null;
        setHeld(false);
      }
    };
    const clearModifier = () => {
      if (showTimer) clearTimeout(showTimer);
      showTimer = null;
      setHeld(false);
    };
    window.addEventListener('keydown', updateModifier);
    window.addEventListener('keyup', updateModifier);
    window.addEventListener('blur', clearModifier);
    document.addEventListener('visibilitychange', clearModifier);
    return () => {
      clearModifier();
      window.removeEventListener('keydown', updateModifier);
      window.removeEventListener('keyup', updateModifier);
      window.removeEventListener('blur', clearModifier);
      document.removeEventListener('visibilitychange', clearModifier);
    };
  }, []);
  useEffect(() => {
    const unsubscribeOpen = window.vault.onOpenFile(() => {
      pickerInvokerRef.current = document.activeElement as HTMLElement;
      setPickerOpen(true);
    });
    const unsubscribeToggle = window.vault.onToggleExplorer(() =>
      setExplorerCollapsed((collapsed) => !collapsed),
    );
    const unsubscribeFormat = window.vault.onFormat((kind) => {
      const target = document.activeElement;
      if (
        !(target instanceof HTMLElement) ||
        !target.closest('.cm-content') ||
        target.closest('input, textarea, [role="dialog"], .cm-vim-panel')
      )
        return;
      editorRef.current?.format?.(kind);
    });
    const unsubscribeNewTab = window.vault.onNewTab(() => {
      if (!pickerOpen && !hasOpenModal()) void createEmptyTab();
    });
    const closeActiveTab = () => {
      if (navigationBusy.current || vaultTransition.current) return;
      const activeTab = tabs.find((tab) => getTabId(tab) === activeId);
      if (activeTab) void closeTab(activeTab);
    };
    const unsubscribeCloseTab = window.vault.onCloseActiveTab(closeActiveTab);
    const onCloseShortcut = (event: KeyboardEvent) => {
      const primary = navigator.platform.toLowerCase().includes('mac')
        ? event.metaKey
        : event.ctrlKey;
      if (
        !primary ||
        event.altKey ||
        event.shiftKey ||
        event.key.toLowerCase() !== 'w'
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeActiveTab();
    };
    window.addEventListener('keydown', onCloseShortcut, true);
    return () => {
      unsubscribeOpen();
      unsubscribeToggle();
      unsubscribeFormat();
      unsubscribeNewTab();
      unsubscribeCloseTab();
      window.removeEventListener('keydown', onCloseShortcut, true);
    };
  }, [pickerOpen, tabs, activeId, agentStatuses]);

  useEffect(() => {
    if (!pickerOpen) {
      if (pickerSelectionFocus.current) {
        pickerSelectionFocus.current = false;
        editorRef.current?.focus();
      } else {
        pickerInvokerRef.current?.focus();
      }
      return;
    }
    setQuery('');
    setHighlightedIndex(0);
    requestAnimationFrame(() => pickerInputRef.current?.focus());
  }, [pickerOpen]);

  const matchingNotes = filterPickerEntries(notes, query);

  const highlightedNote = matchingNotes[highlightedIndex];
  const openPickerEntry = (entry: VaultEntry) => {
    if (entry.kind === 'image') return openImagePreview(entry.path);
    pickerSelectionFocus.current = true;
    return selectNote(entry.path);
  };

  useEffect(() => {
    const requestId = ++pickerPreviewRequest.current;
    if (!pickerOpen || !highlightedNote || !activeVaultId) {
      setPickerPreview(null);
      setPickerPreviewState(null);
      return;
    }
    setPickerPreview(null);
    if (highlightedNote.kind === 'image') {
      setPickerPreviewState(null);
      return;
    }
    setPickerPreviewState('loading');
    void window.vault.readNote(highlightedNote.path).then(
      (note) => {
        if (pickerPreviewRequest.current !== requestId) return;
        setPickerPreview({
          path: highlightedNote.path,
          markdown: note.content,
        });
        setPickerPreviewState(null);
      },
      () => {
        if (pickerPreviewRequest.current !== requestId) return;
        setPickerPreview(null);
        setPickerPreviewState('error');
      },
    );
    return () => {
      if (pickerPreviewRequest.current === requestId)
        pickerPreviewRequest.current++;
    };
  }, [pickerOpen, highlightedNote?.path, activeVaultId]);

  useEffect(() => {
    if (!pickerOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Only take Escape when this palette is the topmost modal. Capture phase
      // lets it win over editor/Vim handlers and already-prevented events.
      const otherModal = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[role="dialog"][aria-modal="true"]',
        ),
      ).some(
        (dialog) =>
          dialog.getAttribute('aria-labelledby') !== 'open-file-title' &&
          isEligibleFocusTarget(dialog),
      );
      if (otherModal) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setPickerOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape, true);
    return () => window.removeEventListener('keydown', closeOnEscape, true);
  }, [pickerOpen]);

  useEffect(() => {
    if (!pickerOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlightedIndex((index) =>
          Math.min(index + 1, matchingNotes.length - 1),
        );
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlightedIndex((index) => Math.max(index - 1, 0));
      } else if (event.key === 'Enter' && matchingNotes[highlightedIndex]) {
        event.preventDefault();
        void openPickerEntry(matchingNotes[highlightedIndex]).then(() =>
          setPickerOpen(false),
        );
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [pickerOpen, matchingNotes, highlightedIndex]);

  useEffect(
    () =>
      window.vault.onShutdownFlush((id) => {
        void (async () => {
          let ok = false;
          try {
            ok = (await editorRef.current?.flush()) ?? true;
            if (ok) {
              if (checkpointTimer.current) {
                clearTimeout(checkpointTimer.current);
                checkpointTimer.current = null;
              }
              const currentVault = activeVaultIdRef.current;
              if (currentVault && visitedVaults.current.has(currentVault))
                rememberCurrentSession(currentVault);
              await checkpointInFlight.current;
              for (const vaultId of visitedVaults.current) {
                const session = sessions.current.get(vaultId);
                if (!session) continue;
                await window.vault.saveTabLayout(
                  vaultId,
                  serializeTabLayout(
                    session.tabs,
                    session.activeId,
                    session.groups,
                    session.assignments,
                    new Map(session.tabs.map((tab) => [getTabId(tab), tab])),
                  ),
                );
              }
            }
          } catch {
            ok = false;
          }
          await window.vault.acknowledgeShutdownFlush(id, ok).catch(() => {});
        })();
      }),
    [],
  );

  const renameEntry = async (path: string, newName: string) => {
    if (renameInProgressRef.current) return;
    renameInProgressRef.current = true;
    setRenameInProgress(true);
    try {
      await coordinateRename({
        flushAllAffectedNotes: async () => {
          if (!((await editorRef.current?.flush()) ?? true)) return false;
          const vaultId = activeVaultIdRef.current;
          if (!vaultId) return true;
          const openNotes = tabsRef.current.filter(
            (tab): tab is Extract<TabSnapshot, { kind: 'note' }> =>
              tab.kind === 'note' && tab.vaultId === vaultId,
          );
          const active = editorRef.current?.snapshot();
          for (const tab of openNotes) {
            const snapshot =
              active?.vaultId === vaultId && active.note.path === tab.note.path
                ? active
                : tab;
            if (snapshot.state.doc.toString() === snapshot.note.content)
              continue;
            const saved = await window.vault.saveNote({
              vaultPath: snapshot.vaultPath,
              path: snapshot.note.path,
              content: snapshot.state.doc.toString(),
              revision: snapshot.note.revision,
            });
            if (!saved?.revision) return false;
          }
          return true;
        },
        mutate: () => window.vault.renameEntry({ path, newName }),
        remap: (rename) => {
          agentHost.current?.invalidateFinishedDocuments([
            rename.oldPath,
            rename.newPath,
            ...rename.changedNotes.map((note) => note.path),
          ]);
          const remapTabs = (source: TabSnapshot[]) =>
            remapRenamedTabs(source, rename, (content) =>
              editorRef.current!.createState(content),
            );
          for (const [id, session] of sessions.current) {
            const nextTabs = remapTabs(session.tabs);
            const nextAssignments = remapRenamedTabAssignments(
              session.assignments,
              rename,
            );
            sessions.current.set(id, {
              ...session,
              tabs: nextTabs,
              assignments: nextAssignments,
            });
            if (id === activeVaultIdRef.current) {
              tabsRef.current = nextTabs;
              assignmentsRef.current = nextAssignments;
              setAssignments(nextAssignments);
              setTabs(nextTabs);
              const active = nextTabs.find(
                (tab) => getTabId(tab) === activeIdRef.current,
              );
              if (active) {
                if (active.kind === 'note') setActivePath(active.note.path);
                else if (active.kind === 'image') setActivePath(active.path);
                editorRef.current?.activate(active);
              }
            }
          }
          if (activeVaultIdRef.current)
            void refreshNotes(activeVaultIdRef.current);
        },
      });
    } finally {
      renameInProgressRef.current = false;
      setRenameInProgress(false);
    }
  };

  const beginCreate = (kind: 'note' | 'folder', parent: string) => {
    if (!activeVaultId || !vaultPath) {
      setVaultError('Open a vault before creating a file.');
      return;
    }
    const vault = vaults.find((item) => item.id === activeVaultId);
    setCreation({
      kind,
      vaultId: activeVaultId,
      parent,
      vaultName:
        vault?.name ??
        vaultPath.split(/[\\/]/).filter(Boolean).at(-1) ??
        'Vault',
    });
    setCreationName('');
  };

  const submitCreation = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!creation || creationPending) return;
    setCreationPending(true);
    let created = false;
    try {
      if (!(await editorRef.current?.flush()))
        throw new Error('Save the current note before creating an entry.');
      const request = {
        vaultId: creation.vaultId,
        parentRelativePath: creation.parent,
        name: creationName.trim(),
      };
      const entry =
        creation.kind === 'note'
          ? await window.vault.createNote(request)
          : await window.vault.createFolder(request);
      created = true;
      setCreation(null);
      if (activeVaultIdRef.current === creation.vaultId) {
        await refreshNotes(creation.vaultId);
        if (creation.kind === 'note') void selectNote(entry.path);
      }
    } catch (error) {
      if (created) {
        setVaultError(
          `Created successfully, but could not finish updating the view: ${error instanceof Error ? error.message : String(error)}`,
        );
      } else {
        const message =
          error instanceof Error ? error.message : 'Unable to create entry.';
        notifyError(message);
      }
    } finally {
      setCreationPending(false);
    }
  };

  const pendingExplorerFocus = useRef(false);
  const pendingExplorerFocusFirst = useRef(false);
  useEffect(() => {
    const rememberFocus = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const pane = target.closest<HTMLElement>('[data-pane]');
      if (pane && (pane.dataset.pane !== 'explorer' || !explorerCollapsed)) {
        lastPane.current = pane.dataset.pane as
          | 'vaults'
          | 'explorer'
          | 'editor';
        lastPaneElement.current = target;
      }
    };
    const restoreOnWindowFocus = () => {
      requestAnimationFrame(() => {
        if (hasOpenModal()) return;
        const active = document.activeElement;
        if (
          active &&
          active !== document.body &&
          active !== document.documentElement
        )
          return;
        const remembered = lastPaneElement.current;
        const rememberedPane = remembered?.closest<HTMLElement>('[data-pane]');
        if (
          isEligibleFocusTarget(remembered) &&
          !(rememberedPane?.dataset.pane === 'explorer' && explorerCollapsed)
        ) {
          remembered.focus();
        } else if (lastPane.current === 'explorer' && !explorerCollapsed) {
          focusExplorerRow();
        } else {
          editorRef.current?.focus();
        }
      });
    };
    document.addEventListener('focusin', rememberFocus);
    window.addEventListener('focus', restoreOnWindowFocus);
    return () => {
      document.removeEventListener('focusin', rememberFocus);
      window.removeEventListener('focus', restoreOnWindowFocus);
    };
  }, [explorerCollapsed]);
  useEffect(() => {
    if (explorerCollapsed && lastPane.current === 'explorer')
      editorRef.current?.focus();
  }, [explorerCollapsed]);
  const focusExplorerRow = (firstRow = false) => {
    const pane = document.querySelector<HTMLElement>('[data-pane="explorer"]');
    const rows = Array.from(
      pane?.querySelectorAll<HTMLElement>('[data-entry-path]') ?? [],
    );
    const row =
      (firstRow
        ? undefined
        : rows.find((item) => item.dataset.entryPath === activePath)) ??
      rows[0];
    const rowButton = row?.querySelector<HTMLElement>('button');
    (rowButton ?? pane)?.focus();
  };

  useEffect(() => {
    if (explorerCollapsed || !pendingExplorerFocus.current) return;
    pendingExplorerFocus.current = false;
    const firstRow = pendingExplorerFocusFirst.current;
    pendingExplorerFocusFirst.current = false;
    focusExplorerRow(firstRow);
  }, [explorerCollapsed, activePath, activeVaultId]);

  useEffect(() => {
    const focusPane = (paneName: 'vaults' | 'explorer' | 'editor') => {
      if (paneName === 'editor') {
        editorRef.current?.focus();
        return;
      }
      if (paneName === 'explorer' && explorerCollapsed) {
        pendingExplorerFocus.current = true;
        pendingExplorerFocusFirst.current = true;
        setExplorerCollapsed(false);
        return;
      }
      const pane = document.querySelector<HTMLElement>(
        `[data-pane="${paneName}"]`,
      );
      if (paneName === 'vaults') {
        const vaultRow = pane?.querySelector<HTMLElement>('[data-vault-row]');
        (vaultRow ?? pane)?.focus();
        return;
      }
      pendingExplorerFocus.current = false;
      pendingExplorerFocusFirst.current = false;
      focusExplorerRow(true);
    };
    return window.vault.onFocusPane((paneName) => {
      if (hasOpenModal()) return;
      focusPane(paneName);
    });
  }, [explorerCollapsed, activePath]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== '?' ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.isComposing ||
        event.repeat ||
        shortcutHelpOpen ||
        settingsOpen ||
        pickerOpen ||
        creation
      )
        return;
      const target = event.target as HTMLElement;
      if (
        target.closest(
          'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="search"]',
        )
      )
        return;
      const activeTab = tabs.find((tab) => getTabId(tab) === activeId);
      const emptyEditor = !activeTab || activeTab.kind === 'empty';
      const pane = target.closest<HTMLElement>('[data-pane]');
      if (pane?.dataset.pane === 'editor') {
        if (!vimMode || !editorRef.current?.isNormalMode()) return;
      } else if (!pane || (vimMode ? false : !emptyEditor)) return;
      shortcutHelpInvoker.current = target;
      event.preventDefault();
      event.stopPropagation();
      setShortcutHelpOpen(true);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [
    shortcutHelpOpen,
    settingsOpen,
    pickerOpen,
    creation,
    tabs,
    activeId,
    vimMode,
  ]);

  useEffect(() => {
    if (!shortcutHelpOpen) {
      shortcutHelpInvoker.current?.focus();
      return;
    }
    shortcutHelpDialog.current?.querySelector<HTMLElement>('button')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setShortcutHelpOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const controls =
        shortcutHelpDialog.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
      if (!controls?.length) {
        event.preventDefault();
        shortcutHelpDialog.current?.focus();
        return;
      }
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [shortcutHelpOpen]);

  useEffect(() => {
    const parentForActiveNote = () => {
      const path = activePath?.replace(/\\/g, '/') ?? '';
      return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    };
    const unsubscribe = window.vault.onCreateEntry((kind) => {
      if (!pickerOpen && !creation) beginCreate(kind, parentForActiveNote());
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'n'
      ) {
        if (pickerOpen || creation) return;
        event.preventDefault();
        beginCreate('note', parentForActiveNote());
      }
      if (event.key === 'Escape' && creation && !creationPending)
        setCreation(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      unsubscribe();
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [
    activePath,
    activeVaultId,
    vaultPath,
    vaults,
    pickerOpen,
    creation,
    creationPending,
  ]);

  const restoreSavedTabs = async () => {
    const vaultId = activeVaultIdRef.current;
    const root = vaultPath;
    if (
      !vaultId ||
      !root ||
      navigationBusy.current ||
      vaultTransition.current ||
      pickerOpen ||
      creation ||
      settingsOpen ||
      shortcutHelpOpen
    )
      return;
    if (
      tabsRef.current.length &&
      !window.confirm('Replace the current tabs with the saved layout?')
    )
      return;
    navigationBusy.current = true;
    const requestId = ++noteRequestId.current;
    try {
      if (!(await editorRef.current?.flush())) return;
      if (
        requestId !== noteRequestId.current ||
        activeVaultIdRef.current !== vaultId
      )
        return;
      const layout = await window.vault.getTabLayout(vaultId);
      if (!layout) return;
      const restored: TabSnapshot[] = [];
      for (const item of layout.tabs) {
        if (item.kind === 'empty') {
          restored.push({ kind: 'empty', id: item.id });
          continue;
        }
        if (item.kind === 'image') {
          restored.push({
            kind: 'image',
            vaultId,
            path: item.path,
            filename: item.path.split(/[\\/]/).at(-1) || item.path,
          });
          continue;
        }
        try {
          const note = await window.vault.readNote(item.path);
          if (
            requestId !== noteRequestId.current ||
            activeVaultIdRef.current !== vaultId
          )
            return;
          const state = editorRef.current!.createState(note.content);
          const length = state.doc.length;
          const safe = (position: number) =>
            Math.max(0, Math.min(length, position));
          const nextState = state.update({
            selection: { anchor: safe(item.anchor), head: safe(item.head) },
          }).state;
          restored.push({
            kind: 'note',
            note,
            vaultPath: root,
            vaultId,
            state: nextState,
            scrollTop: Math.max(0, item.scrollTop),
          });
        } catch {
          /* Missing/unreadable notes are skipped without blocking other tabs. */
        }
      }
      if (
        !restored.length &&
        layout.tabs.some(
          (item) => item.kind === 'note' || item.kind === 'image',
        )
      ) {
        setVaultError(STARTUP_VAULT_ERROR);
        return;
      }
      const savedGroups = layout.groups.map(
        (group) => ({ ...group }) as TabGroup,
      );
      const ids = restored.map(getTabId);
      const savedAssignments = cleanTabAssignments(
        layout.assignments,
        ids,
        savedGroups,
      );
      const normalized = normalizeTabGroupState(
        restored,
        savedGroups,
        savedAssignments,
      );
      const { groups, assignments } = normalized;
      const selected =
        restored.find((tab) => getTabId(tab) === layout.activeTab) ??
        restored[0] ??
        null;
      tabsRef.current = restored;
      groupsRef.current = groups;
      assignmentsRef.current = assignments;
      setTabs(restored);
      setTabGroups(groups);
      setTabGroupAssignments(assignments);
      if (selected) {
        editorRef.current?.activate(selected);
        setActiveId(getTabId(selected));
        setActivePath(selected.kind === 'note' ? selected.note.path : null);
      } else {
        editorRef.current?.clear();
        setActiveId(null);
        setActivePath(null);
      }
      visitedVaults.current.add(vaultId);
      rememberCurrentSession(vaultId);
      const restoredActiveId = selected ? getTabId(selected) : null;
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (
          active &&
          active !== document.body &&
          active !== document.documentElement
        )
          return;
        if (
          hasOpenModal() ||
          activeVaultIdRef.current !== vaultId ||
          activeIdRef.current !== restoredActiveId
        )
          return;
        editorRef.current?.focus();
      });
      setVaultError(null);
    } catch (error) {
      setVaultError(
        error instanceof Error ? error.message : 'Unable to restore saved tabs',
      );
    } finally {
      navigationBusy.current = false;
    }
  };

  useEffect(
    () =>
      window.vault.onRestoreTabs(() => {
        void restoreSavedTabs();
      }),
    [
      activeVaultId,
      vaultPath,
      pickerOpen,
      creation,
      settingsOpen,
      shortcutHelpOpen,
    ],
  );

  const handleDeleteEntry = async (path: string) => {
    const vaultId = activeVaultIdRef.current;
    if (
      !vaultId ||
      !vaultPath ||
      navigationBusy.current ||
      vaultTransition.current ||
      hasOpenModal()
    )
      return;
    navigationBusy.current = true;
    ++noteRequestId.current;
    try {
      if (!(await editorRef.current?.flush())) return;
      if (activeVaultIdRef.current !== vaultId) return;
      const currentTabs = tabsRef.current;
      const currentActiveId = activeIdRef.current;
      const outgoing = editorRef.current?.snapshot();
      const freshTabs = outgoing
        ? currentTabs.map((tab) =>
            tab.kind === 'note' && tab.note.path === outgoing.note.path
              ? outgoing
              : tab,
          )
        : currentTabs;
      const result = await window.vault.deleteEntry({ vaultId, path });
      if (!result.deleted) return;
      const normalize = (value: string) =>
        value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      const deletedPath = normalize(result.path);
      const matchesDeleted = (tab: TabSnapshot) => {
        if (tab.kind === 'empty' || tab.vaultId !== vaultId) return false;
        const tabPath = normalize(
          tab.kind === 'note' ? tab.note.path : tab.path,
        );
        return (
          tabPath === deletedPath ||
          (result.kind === 'folder' && tabPath.startsWith(`${deletedPath}/`))
        );
      };
      const removedActive = freshTabs.find(
        (tab) => getTabId(tab) === currentActiveId && matchesDeleted(tab),
      );
      const remaining = freshTabs.filter((tab) => !matchesDeleted(tab));
      const assignments = { ...assignmentsRef.current };
      for (const tab of freshTabs)
        if (matchesDeleted(tab)) delete assignments[getTabId(tab)];
      const normalized = normalizeTabGroupState(
        remaining,
        groupsRef.current,
        assignments,
      );
      const { groups } = normalized;
      const nextAssignments = normalized.assignments;
      const activeIndex = freshTabs.findIndex(
        (tab) => getTabId(tab) === currentActiveId,
      );
      let nextActive = remaining.find(
        (tab) => getTabId(tab) === currentActiveId,
      );
      if (!nextActive && remaining.length) {
        const nearestIndex = Math.min(
          Math.max(activeIndex, 0),
          remaining.length - 1,
        );
        nextActive = remaining[nearestIndex];
      }
      if (removedActive) {
        editorRef.current?.clear();
        if (nextActive?.kind === 'note')
          editorRef.current?.activate(nextActive);
        else if (nextActive?.kind === 'empty')
          editorRef.current?.activate(nextActive);
      }
      tabsRef.current = remaining;
      activeIdRef.current = nextActive ? getTabId(nextActive) : null;
      groupsRef.current = groups;
      assignmentsRef.current = nextAssignments;
      setTabs(remaining);
      setActiveId(activeIdRef.current);
      setActivePath(nextActive?.kind === 'note' ? nextActive.note.path : null);
      setTabGroups(groups);
      setTabGroupAssignments(nextAssignments);
      visitedVaults.current.add(vaultId);
      sessions.current.set(vaultId, {
        tabs: remaining,
        activeId: activeIdRef.current,
        groups,
        assignments: nextAssignments,
      });
      if (checkpointTimer.current) {
        clearTimeout(checkpointTimer.current);
        checkpointTimer.current = null;
      }
      const previousCheckpoint = checkpointInFlight.current;
      const saveLayout = async () => {
        await previousCheckpoint?.catch(() => {});
        await window.vault.saveTabLayout(
          vaultId,
          serializeTabLayout(
            remaining,
            activeIdRef.current,
            groups,
            nextAssignments,
            new Map(remaining.map((tab) => [getTabId(tab), tab])),
          ),
        );
      };
      checkpointInFlight.current = saveLayout();
      try {
        await checkpointInFlight.current;
      } catch (error) {
        notifyError(
          `Deleted successfully, but could not save tab layout: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (activeVaultIdRef.current === vaultId) await refreshNotes(vaultId);
    } catch (error) {
      notifyError(
        error instanceof Error ? error.message : 'Unable to delete entry.',
      );
    } finally {
      navigationBusy.current = false;
    }
  };

  const selectNote = async (path: string, focusEditor = true) => {
    if (path === activePath) {
      if (focusEditor) editorRef.current?.focus();
      return;
    }
    if (navigationBusy.current || vaultTransition.current || !vaultPath) return;
    navigationBusy.current = true;
    const requestId = ++noteRequestId.current;
    try {
      if (!(await editorRef.current?.flush())) return;
      if (requestId !== noteRequestId.current) return;
      const outgoing = editorRef.current?.snapshot();
      if (outgoing)
        setTabs((old) =>
          old.map((tab) =>
            tab.kind === 'note' && tab.note.path === outgoing.note.path
              ? outgoing
              : tab,
          ),
        );
      const existing = tabs.find(
        (tab) => tab.kind === 'note' && tab.note.path === path,
      );
      if (existing) {
        activateTab(existing);
        if (focusEditor) editorRef.current?.focus();
        return;
      }
      const replacedEmpty = tabs.find(
        (tab) => tab.kind === 'empty' && getTabId(tab) === activeId,
      );
      const removedEmptyIds = tabs
        .filter((tab) => tab.kind === 'empty')
        .map(getTabId);
      const inheritedGroup = replacedEmpty
        ? tabGroupAssignments[getTabId(replacedEmpty)]
        : undefined;
      const note = await window.vault.readNote(path);
      if (requestId !== noteRequestId.current) return;
      if (!activeVaultId) return;
      visitedVaults.current.add(activeVaultId);
      editorRef.current?.openNote(note, vaultPath, activeVaultId);
      if (focusEditor) editorRef.current?.focus();
      const fresh = editorRef.current?.snapshot();
      if (fresh)
        setTabs((old) => [
          ...old.filter(
            (tab) =>
              tab.kind !== 'empty' &&
              (tab.kind !== 'note' || tab.note.path !== path),
          ),
          fresh,
        ]);
      if (replacedEmpty) {
        setTabGroupAssignments((assignments) => {
          const next = { ...assignments };
          for (const id of removedEmptyIds) delete next[id];
          if (inheritedGroup) next[path] = inheritedGroup;
          return next;
        });
      }
      const assignedGroup = inheritedGroup;
      if (assignedGroup)
        setTabGroups((groups) =>
          groups.map((group) =>
            group.id === assignedGroup ? { ...group, collapsed: false } : group,
          ),
        );
      setActivePath(path);
      setActiveId(path);
    } catch (error) {
      console.error('Unable to open note', error);
    } finally {
      navigationBusy.current = false;
    }
  };

  const openWikiNote = async (target: string, sourceNotePath = activePath) => {
    if (!activeVaultId || !sourceNotePath) return;
    const vaultId = activeVaultId;
    const notePath = sourceNotePath;
    const requestId = ++noteRequestId.current;
    try {
      const result = await window.vault.resolveNoteLink({
        vaultId,
        notePath,
        target,
      });
      if (
        requestId !== noteRequestId.current ||
        vaultId !== activeVaultIdRef.current
      )
        return;
      if (!result.ok) {
        notifyError(
          result.reason === 'ambiguous'
            ? 'Note link is ambiguous.'
            : result.reason === 'missing'
              ? 'Note not found.'
              : 'Invalid note link.',
        );
        return;
      }
      await selectNote(result.path);
    } catch {
      notifyError('Note could not be opened.');
    }
  };

  const activateTab = (tab: TabSnapshot) => {
    const groupId = tabGroupAssignments[getTabId(tab)];
    if (groupId)
      setTabGroups((groups) =>
        groups.map((group) =>
          group.id === groupId ? { ...group, collapsed: false } : group,
        ),
      );
    editorRef.current?.activate(tab);
    setActiveId(getTabId(tab));
    setActivePath(tab.kind === 'note' ? tab.note.path : null);
  };
  const createEmptyTab = async () => {
    if (navigationBusy.current || vaultTransition.current) return;
    navigationBusy.current = true;
    try {
      if (!(await editorRef.current?.flush())) return;
      const outgoing = editorRef.current?.snapshot();
      if (outgoing)
        setTabs((old) =>
          old.map((tab) =>
            tab.kind === 'note' && tab.note.path === outgoing.note.path
              ? outgoing
              : tab,
          ),
        );
      if (activeVaultId) visitedVaults.current.add(activeVaultId);
      const empty: TabSnapshot = { kind: 'empty', id: crypto.randomUUID() };
      const inheritedGroup = activeId
        ? tabGroupAssignments[activeId]
        : undefined;
      if (inheritedGroup)
        setTabGroupAssignments((assignments) => ({
          ...assignments,
          [empty.id]: inheritedGroup,
        }));
      setTabs((old) => [...old, empty]);
      activateTab(empty);
    } finally {
      navigationBusy.current = false;
    }
  };
  const closeTab = async (target: TabSnapshot) => {
    if (navigationBusy.current) return;
    const targetId = getTabId(target);
    const targetPath = target.kind === 'note' ? target.note.path : null;
    if (target.kind === 'note' && isAgentTabProtected(target, agentStatuses))
      return;
    if (targetPath) {
      const adapter =
        activeVaultId && target.vaultId === activeVaultId
          ? agentHost.current?.getAdapterFor(target.vaultId, targetPath)
          : undefined;
      if (adapter && !(await adapter.flush())) {
        setVaultError(
          'Could not save accepted agent updates before closing the note.',
        );
        return;
      }
    }
    const transition = closeTabTransition(tabs, targetId, activeId, getTabId);
    if (activeVaultId) visitedVaults.current.add(activeVaultId);
    if (!transition.wasActive) {
      const { remaining } = transition;
      const normalized = normalizeTabGroupState(
        remaining,
        groupsRef.current,
        assignmentsRef.current,
      );
      if (!remaining.length) {
        groupsRef.current = normalized.groups;
        assignmentsRef.current = normalized.assignments;
        setTabGroups(normalized.groups);
        setTabGroupAssignments(normalized.assignments);
      }
      setTabs(remaining);
      setTabGroupAssignments((assignments) => {
        const next = { ...assignments };
        delete next[targetId];
        return next;
      });
      return;
    }
    navigationBusy.current = true;
    try {
      if (!(await editorRef.current?.flush())) return;
      const { remaining, nextActive } = closeTabTransition(
        tabsRef.current,
        targetId,
        activeId,
        getTabId,
      );
      if (nextActive) activateTab(nextActive);
      else {
        ++noteRequestId.current;
        editorRef.current?.clear();
        setActivePath(null);
        setActiveId(null);
      }
      setTabs(remaining);
      const normalized = normalizeTabGroupState(
        remaining,
        groupsRef.current,
        Object.fromEntries(
          Object.entries(assignmentsRef.current).filter(
            ([id]) => id !== targetId,
          ),
        ),
      );
      groupsRef.current = normalized.groups;
      assignmentsRef.current = normalized.assignments;
      if (!remaining.length) setTabGroups(normalized.groups);
      setTabGroupAssignments(normalized.assignments);
    } finally {
      navigationBusy.current = false;
    }
  };
  const beginVaultChange = () => {
    if (vaultTransition.current) return false;
    vaultTransition.current = true;
    ++noteRequestId.current;
    return true;
  };
  const cancelVaultChange = () => {
    vaultTransition.current = false;
  };

  const activateVault = async (
    id: string,
    focusDestination = false,
    retainFocus = false,
  ) => {
    if (id === activeVaultId) {
      if (focusDestination) {
        if (
          activePath &&
          tabs.some(
            (tab) => tab.kind === 'note' && tab.note.path === activePath,
          )
        ) {
          editorRef.current?.focus();
        } else if (explorerCollapsed) {
          pendingExplorerFocus.current = true;
          setExplorerCollapsed(false);
        } else {
          focusExplorerRow();
        }
      }
      return true;
    }
    if (navigationBusy.current || !beginVaultChange()) return false;
    navigationBusy.current = true;
    setVaultError(null);
    try {
      if (!(await editorRef.current?.flush())) {
        cancelVaultChange();
        return false;
      }
      const outgoing = editorRef.current?.snapshot();
      if (activeVaultId) {
        if (
          tabs.length ||
          tabGroups.length ||
          Object.keys(tabGroupAssignments).length
        )
          visitedVaults.current.add(activeVaultId);
        const outgoingTabs = outgoing
          ? tabs.map((tab) =>
              tab.kind === 'note' && tab.note.path === outgoing.note.path
                ? outgoing
                : tab,
            )
          : tabs;
        sessions.current.set(activeVaultId, {
          tabs: outgoingTabs,
          activeId,
          groups: tabGroups,
          assignments: tabGroupAssignments,
        });
        scheduleCheckpoint();
      }
      const activated = await window.vault.registryActivate(id);
      if (!activated.path)
        throw new Error(
          'Vault folder is unavailable. Choose or move the folder to recover.',
        );
      ++notesRefreshRequest.current;
      const listed = await window.vault.listNotes();
      const session = sessions.current.get(id);
      let restoredTabs: TabSnapshot[] = [];
      if (session) {
        for (const tab of session.tabs) {
          if (tab.kind === 'empty' || tab.kind === 'image') {
            restoredTabs.push(tab);
            continue;
          }
          try {
            const latest = await window.vault.readNote(tab.note.path);
            restoredTabs.push(
              latest.revision === tab.note.revision &&
                tab.vaultPath === activated.path
                ? tab
                : {
                    ...tab,
                    note: latest,
                    vaultPath: activated.path,
                    vaultId: id,
                    state: editorRef.current!.createState(latest.content),
                    scrollTop: 0,
                  },
            );
          } catch {
            // Deleted or inaccessible notes are omitted from this vault session.
          }
        }
      }
      const normalizedSession = normalizeTabGroupState(
        restoredTabs,
        session?.groups ?? [],
        cleanTabAssignments(
          session?.assignments ?? {},
          restoredTabs,
          session?.groups ?? [],
        ),
      );
      const restoredId = restoredTabs.some(
        (tab) => getTabId(tab) === session?.activeId,
      )
        ? session!.activeId
        : restoredTabs.length
          ? getTabId(restoredTabs.at(-1)!)
          : null;
      const activeTab = restoredTabs.find(
        (tab) => getTabId(tab) === restoredId,
      );
      if (activeTab) editorRef.current?.activate(activeTab);
      else editorRef.current?.clear();
      tabsRef.current = restoredTabs;
      groupsRef.current = normalizedSession.groups;
      assignmentsRef.current = normalizedSession.assignments;
      setTabs(restoredTabs);
      setTabGroups(normalizedSession.groups);
      setTabGroupAssignments(normalizedSession.assignments);
      setActiveId(restoredId);
      setActivePath(activeTab?.kind === 'note' ? activeTab.note.path : null);
      setActiveVaultId(id);
      activeVaultIdRef.current = id;
      setVaultPath(activated.path);
      setNotes(listed);
      const restoredActiveId = activeTab ? getTabId(activeTab) : null;
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (
          !focusDestination &&
          active &&
          active !== document.body &&
          active !== document.documentElement
        )
          return;
        if (
          retainFocus ||
          hasOpenModal() ||
          activeVaultIdRef.current !== id ||
          activeIdRef.current !== restoredActiveId
        )
          return;
        if (focusDestination && activeTab?.kind !== 'note') {
          if (explorerCollapsed) {
            pendingExplorerFocus.current = true;
            setExplorerCollapsed(false);
          } else focusExplorerRow();
        } else {
          editorRef.current?.focus();
        }
      });
      return true;
    } catch (error) {
      if (activeVaultId) {
        try {
          await window.vault.registryActivate(activeVaultId);
        } catch {
          /* Preserve prior UI on rollback failure. */
        }
      }
      cancelVaultChange();
      setVaultError(
        error instanceof Error ? error.message : 'Unable to activate vault',
      );
      return false;
    } finally {
      navigationBusy.current = false;
      vaultTransition.current = false;
      setEntriesLoading(false);
      if (pendingVaultRefresh.current) {
        const pendingVaultId = pendingVaultRefresh.current;
        pendingVaultRefresh.current = null;
        if (activeVaultIdRef.current === pendingVaultId)
          void refreshNotes(pendingVaultId);
      }
    }
  };

  useEffect(() => {
    const unsubscribeTab = window.vault.onSelectTabIndex((index) => {
      if (pickerOpen) return;
      const tab = visibleTabOrder(tabs, tabGroups, tabGroupAssignments)[index];
      if (tab) {
        if (tab.kind === 'note') void selectNote(tab.note.path);
        else if (!navigationBusy.current) {
          void (async () => {
            if (!(await editorRef.current?.flush())) return;
            const outgoing = editorRef.current?.snapshot();
            if (outgoing)
              setTabs((old) =>
                old.map((item) =>
                  item.kind === 'note' && item.note.path === outgoing.note.path
                    ? outgoing
                    : item,
                ),
              );
            activateTab(tab);
          })();
        }
      }
    });
    const unsubscribeVault = window.vault.onActivateVaultIndex((index) => {
      if (pickerOpen) return;
      const vault = visibleVaults[index];
      if (vault) void activateVault(vault.id);
    });
    return () => {
      unsubscribeTab();
      unsubscribeVault();
    };
  }, [
    tabs,
    visibleVaults,
    pickerOpen,
    activePath,
    vaultPath,
    activeVaultId,
    tabGroups,
    tabGroupAssignments,
  ]);

  const removeVault = async (id: string) => {
    const vault = vaults.find((item) => item.id === id);
    if (!vault || navigationBusy.current || vaultTransition.current) return;
    const liveAgent = Object.values(agentStatuses).some((status) => {
      const path = status.absolutePath.replace(/\\/g, '/');
      const root = vault.path.replace(/\\/g, '/').replace(/\/$/, '');
      return (
        (status.state === 'connected' || status.state === 'writing') &&
        (path === root || path.startsWith(`${root}/`))
      );
    });
    if (liveAgent) {
      setVaultError(
        'Stop the connected agent session before unloading this vault.',
      );
      return;
    }
    if (
      !window.confirm(
        `Unload “${vault.name}” from Storm? Its folder and files will be kept.`,
      )
    )
      return;
    navigationBusy.current = true;
    try {
      const root = vault.path.replace(/\\/g, '/').replace(/\/$/, '');
      for (const status of Object.values(agentStatuses)) {
        const absolutePath = status.absolutePath.replace(/\\/g, '/');
        if (!absolutePath.startsWith(`${root}/`)) continue;
        const relativePath = absolutePath.slice(root.length + 1);
        const adapter = agentAdaptersRef.current.get(
          JSON.stringify([id, relativePath]),
        );
        if (adapter && !(await adapter.flush()))
          throw new Error(
            'Could not save agent updates; vault was not unloaded.',
          );
      }
      if (id === activeVaultIdRef.current) {
        if (!(await editorRef.current?.flush()))
          throw new Error(
            'Could not save the current note; vault was not unloaded.',
          );
        if (checkpointTimer.current) {
          clearTimeout(checkpointTimer.current);
          checkpointTimer.current = null;
        }
        await checkpointInFlight.current;
        const fallback = vaults.find((item) => item.id !== id);
        if (fallback) {
          navigationBusy.current = false;
          const switched = await activateVault(fallback.id);
          navigationBusy.current = true;
          if (!switched)
            throw new Error('Could not switch vault; nothing was unloaded.');
        }
      }
      await window.vault.registryUnloadVault(id);
      sessions.current.delete(id);
      visitedVaults.current.delete(id);
      setVaults((old) => old.filter((item) => item.id !== id));
      if (id === activeVaultIdRef.current) {
        editorRef.current?.clear();
        tabsRef.current = [];
        activeIdRef.current = null;
        setTabs([]);
        setActiveId(null);
        setActivePath(null);
        setActiveVaultId(null);
        activeVaultIdRef.current = null;
        setVaultPath(null);
        setNotes([]);
        setTabGroups([]);
        setTabGroupAssignments({});
        groupsRef.current = [];
        assignmentsRef.current = {};
      }
      setVaultError(null);
      notifySuccess('Vault unloaded. Its files were not changed.');
    } catch (error) {
      setVaultError(
        error instanceof Error ? error.message : 'Unable to unload vault',
      );
    } finally {
      navigationBusy.current = false;
    }
  };

  const unloadAllVaults = async (): Promise<boolean> => {
    if (navigationBusy.current || !beginVaultChange()) return false;
    navigationBusy.current = true;
    try {
      if (!(await editorRef.current?.flush()))
        throw new Error(
          'Could not save the current note; vaults were not unloaded.',
        );
      const currentVault = activeVaultIdRef.current;
      if (currentVault && visitedVaults.current.has(currentVault))
        rememberCurrentSession(currentVault);
      if (checkpointTimer.current) {
        clearTimeout(checkpointTimer.current);
        checkpointTimer.current = null;
      }
      await checkpointInFlight.current;
      for (const [vaultId, session] of sessions.current) {
        await window.vault.saveTabLayout(
          vaultId,
          serializeTabLayout(
            session.tabs,
            session.activeId,
            session.groups,
            session.assignments,
            new Map(session.tabs.map((tab) => [getTabId(tab), tab])),
          ),
        );
      }
      await window.vault.registryUnloadAll();
      ++noteRequestId.current;
      ++notesRefreshRequest.current;
      ++pickerPreviewRequest.current;
      editorRef.current?.clear();
      sessions.current.clear();
      visitedVaults.current.clear();
      tabsRef.current = [];
      activeIdRef.current = null;
      groupsRef.current = [];
      assignmentsRef.current = {};
      setTabs([]);
      setActivePath(null);
      setActiveId(null);
      setTabGroups([]);
      setTabGroupAssignments({});
      setVaults([]);
      setVaultGroups([]);
      setActiveVaultId(null);
      activeVaultIdRef.current = null;
      setVaultPath(null);
      setNotes([]);
      setEntriesLoading(false);
      setReadingModes({});
      setCreationName('');
      setPickerOpen(false);
      setQuery('');
      setPickerPreview(null);
      setPickerPreviewState(null);
      setCreation(null);
      setVaultError(null);
      notifySuccess('All vaults unloaded. Your files were not changed.');
      return true;
    } catch (error) {
      setVaultError(
        error instanceof Error ? error.message : 'Unable to unload vaults.',
      );
      return false;
    } finally {
      navigationBusy.current = false;
      cancelVaultChange();
    }
  };

  const addVault = async () => {
    if (navigationBusy.current || !beginVaultChange()) return;
    navigationBusy.current = true;
    try {
      if (!(await editorRef.current?.flush())) {
        cancelVaultChange();
        return;
      }
      const selection = await window.vault.choose();
      if (!selection.path) {
        cancelVaultChange();
        return;
      }
      const { vault } = await window.vault.registryAdd(selection.path);
      setVaults((old) =>
        old.some((item) => item.id === vault.id) ? old : [...old, vault],
      );
      navigationBusy.current = false;
      cancelVaultChange();
      await activateVault(vault.id);
    } catch (error) {
      cancelVaultChange();
      setVaultError(
        error instanceof Error ? error.message : 'Unable to add vault',
      );
    } finally {
      navigationBusy.current = false;
    }
  };

  useEffect(() => {
    let current = true;
    void window.vault
      .registryList()
      .then(
        async ({
          vaults: registered,
          activeVaultId: active,
          sidebarRootOrder: rootOrder,
        }) => {
          const groups = await window.vault.groupsList();
          if (!current) return;
          setVaultGroups(groups);
          setSidebarRootOrder(rootOrder);
          if (!current) return;
          setVaults(registered);
          if (!active) return;
          try {
            const result = await window.vault.registryActivate(active);
            if (!current) return;
            if (!result.path)
              throw new Error(
                'Vault folder is unavailable. Choose or move the folder to recover.',
              );
            setActiveVaultId(active);
            activeVaultIdRef.current = active;
            setVaultPath(result.path);
            setEntriesLoading(true);
            const listRequestId = ++notesRefreshRequest.current;
            const listed = await window.vault.listNotes();
            if (current && listRequestId === notesRefreshRequest.current) {
              setNotes(listed);
            }
          } catch {
            if (current) setVaultError(STARTUP_VAULT_ERROR);
          } finally {
            if (current) setEntriesLoading(false);
          }
        },
      )
      .catch(() => {
        if (current) setVaultError(STARTUP_VAULT_ERROR);
      });
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    if (
      !activeVaultId ||
      !vaultPath ||
      visitedVaults.current.has(activeVaultId)
    )
      return;
    void restoreSavedTabs();
  }, [activeVaultId, vaultPath]);

  const toggleReadingMode = () => {
    if (navigationBusy.current || vaultTransition.current || hasOpenModal())
      return;
    if (!readingModeKey || !activeId) return;
    setReadingModes((modes) => ({
      ...modes,
      [readingModeKey]: !modes[readingModeKey],
    }));
  };

  useEffect(
    () => window.vault.onToggleReadMode(toggleReadingMode),
    [activeId, activePath, readingMode, readingModeKey],
  );

  return (
    <main className="flex h-screen min-h-0 w-full min-w-0 flex-col">
      {shortcutHelpOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget)
              setShortcutHelpOpen(false);
          }}
        >
          <section
            ref={shortcutHelpDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="shortcut-help-title"
            className="max-h-[85vh] w-full max-w-xl overflow-y-auto rounded-xl border border-white/15 bg-[#17191d] p-6 text-white shadow-2xl outline-none"
            tabIndex={-1}
          >
            <div className="mb-5 flex items-center justify-between">
              <h2 id="shortcut-help-title" className="text-lg font-semibold">
                Keyboard shortcuts
              </h2>
              <button
                autoFocus
                onClick={() => setShortcutHelpOpen(false)}
                className="rounded px-3 py-1 text-sm text-white/70 hover:bg-white/10 hover:text-white"
              >
                Close
              </button>
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              <ShortcutGroup
                title="Navigation"
                items={[
                  navigator.platform.toLowerCase().includes('mac')
                    ? 'Ctrl+1 / Ctrl+2 / Ctrl+3 — Focus Vaults / Explorer / Editor'
                    : 'Alt+1 / Alt+2 / Alt+3 — Focus Vaults / Explorer / Editor',
                  ...(vimMode
                    ? ['h / j / k / l — Navigate panes and files']
                    : []),
                  'Enter / l — Open focused item',
                  '⌘⇧T / Ctrl+Shift+T — Restore saved tabs',
                  ...(vimMode
                    ? ['i — Enter insert mode', 'Esc — Return to normal mode']
                    : []),
                ]}
              />
              <ShortcutGroup
                title="App"
                items={[
                  'Ctrl+W — Close current tab',
                  (navigator.platform.toLowerCase().includes('mac')
                    ? '⌘'
                    : 'Ctrl') + 'T — New empty tab',
                  (navigator.platform.toLowerCase().includes('mac')
                    ? '⌘'
                    : 'Ctrl') + 'N — New note',
                  (navigator.platform.toLowerCase().includes('mac')
                    ? '⌘⇧'
                    : 'Ctrl+Shift+') + 'N — New folder',
                  (navigator.platform.toLowerCase().includes('mac')
                    ? '⌘'
                    : 'Ctrl') +
                    'P — Search notes' +
                    (openFileShortcut ? '' : ' (disabled)'),
                  (navigator.platform.toLowerCase().includes('mac')
                    ? '⌘'
                    : 'Ctrl') +
                    'S — Toggle file explorer' +
                    (toggleExplorerShortcut ? '' : ' (disabled)'),
                  (navigator.platform.toLowerCase().includes('mac')
                    ? '⌘'
                    : 'Ctrl') + ', — Settings',
                  (navigator.platform.toLowerCase().includes('mac')
                    ? '⌘⇧'
                    : 'Ctrl+Shift+') + 'M — Toggle preview',
                  (navigator.platform.toLowerCase().includes('mac')
                    ? '⌘'
                    : 'Ctrl') + 'E — Toggle reading mode',
                  (navigator.platform.toLowerCase().includes('mac')
                    ? '⌘'
                    : 'Ctrl') + 'B / I — Bold / italic in the editor',
                  (navigator.platform.toLowerCase().includes('mac')
                    ? '⌘'
                    : 'Ctrl') + '1–9 — Select tab',
                  (navigator.platform.toLowerCase().includes('mac')
                    ? '⌃⇧'
                    : 'Ctrl+Shift+') + '1–9 — Select vault',
                ]}
              />
            </div>
            {vimMode && (
              <p className="mt-5 text-xs text-white/50">
                In Vim normal mode, ? opens this help instead of backward
                search.
              </p>
            )}
          </section>
        </div>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-row">
        <div className="contents">
          <VaultSidebar
            vaults={vaults}
            groups={vaultGroups}
            sidebarRootOrder={sidebarRootOrder}
            onSidebarRootOrderChange={setSidebarRootOrder}
            visibleVaults={visibleVaults}
            onGroupsChange={setVaultGroups}
            onVaultsChange={setVaults}
            activeVaultId={activeVaultId}
            onActivate={activateVault}
            onAdd={addVault}
            collapsed={explorerCollapsed}
            onToggleExplorer={() => setExplorerCollapsed(false)}
            toggleExplorerShortcut={toggleExplorerShortcut}
            onRemove={removeVault}
            error={vaultError}
            commandHeld={commandHeld}
            vimMode={vimMode}
            onOpenSettings={() => setSettingsOpen(true)}
          />
          <FileExplorer
            vaultPath={vaultPath}
            notes={notes}
            loading={entriesLoading}
            error={vaultError}
            onAddVault={addVault}
            onUnloadAllVaults={unloadAllVaults}
            vaultCount={vaults.length}
            collapsed={explorerCollapsed}
            onToggleCollapsed={() =>
              setExplorerCollapsed((collapsed) => !collapsed)
            }
            onCopyPathError={notifyError}
            onPathCopied={notifySuccess}
            onNoteSelect={selectNote}
            onImageSelect={(path) => void openImagePreview(path)}
            vaultId={activeVaultId}
            onDeleteEntry={(path) => void handleDeleteEntry(path)}
            onRenameEntry={renameEntry}
            onCreate={beginCreate}
            onCreateNote={() => {
              const path = activePath?.replace(/\\/g, '/') ?? '';
              beginCreate(
                'note',
                path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
              );
            }}
            creationPending={creationPending}
            vimMode={vimMode}
            onVimModeChange={setVimMode}
            settingsOpen={settingsOpen}
            appearance={appearance}
            onAppearanceChange={setAppearance}
            onSettingsOpenChange={setSettingsOpen}
            openFileShortcut={openFileShortcut}
            onOpenFileShortcutChange={setOpenFileShortcut}
            toggleExplorerShortcut={toggleExplorerShortcut}
            commandHeld={commandHeld}
            onToggleExplorerShortcutChange={setToggleExplorerShortcut}
            selectedPath={activePath}
          />
        </div>
        <Editor
          ref={editorRef}
          imageAsset={(() => {
            const tab = tabs.find((item) => getTabId(item) === activeId);
            return tab?.kind === 'image' && tab.vaultId === activeVaultId
              ? { vaultId: tab.vaultId, path: tab.path, filename: tab.filename }
              : null;
          })()}
          readingMode={readingMode}
          onOpenNote={openWikiNote}
          onToggleReadingMode={toggleReadingMode}
          commandHeld={commandHeld}
          vimMode={vimMode}
          renameInProgress={renameInProgress}
          appearance={appearance}
          tabsVisible={hasOpenTabs(tabs)}
          vaultId={activeVaultId}
          agentDocument={activeAgentAdapter}
          agentStatus={activeAgentStatus}
          agentWriting={matchingAgentStatuses.some(
            (status) => status.state === 'writing',
          )}
          agentGenerationFinished={
            matchingAgentStatuses.length > 0 &&
            matchingAgentStatuses.every((status) => status.state === 'finished')
          }
          onStopAgent={(sessionId) => {
            window.stormAgent.cancel(sessionId, 'Stopped from editor');
            setAgentStatuses((current) => ({
              ...current,
              [sessionId]: { ...current[sessionId], state: 'cancelled' },
            }));
          }}
          onLayoutChange={() => {
            const vaultId = activeVaultIdRef.current;
            const latest = editorRef.current?.snapshot();
            if (!vaultId || !latest) return;
            visitedVaults.current.add(vaultId);
            const currentTabs = tabsRef.current.map((tab) =>
              tab.kind === 'note' && tab.note.path === latest.note.path
                ? latest
                : tab,
            );
            sessions.current.set(vaultId, {
              tabs: currentTabs,
              activeId: activeIdRef.current,
              groups: groupsRef.current,
              assignments: assignmentsRef.current,
            });
            scheduleCheckpoint();
          }}
          tabs={
            <TabBar
              commandHeld={commandHeld}
              tabs={tabs}
              activeId={activeId}
              onSelect={(tab) =>
                tab.kind === 'note'
                  ? void selectNote(tab.note.path)
                  : void (async () => {
                      if (!(await editorRef.current?.flush())) return;
                      const outgoing = editorRef.current?.snapshot();
                      if (outgoing)
                        setTabs((old) =>
                          old.map((item) =>
                            item.kind === 'note' &&
                            item.note.path === outgoing.note.path
                              ? outgoing
                              : item,
                          ),
                        );
                      activateTab(tab);
                    })()
              }
              canCloseTab={(tab) =>
                tab.kind !== 'note' || !isAgentTabProtected(tab, agentStatuses)
              }
              onClose={(tab) => {
                void closeTab(tab);
              }}
              onNew={() => {
                void createEmptyTab();
              }}
              groups={tabGroups}
              assignments={tabGroupAssignments}
              onGroupsChange={(groups) => {
                setTabGroups(groups);
                groupsRef.current = groups;
                if (activeVaultId) {
                  visitedVaults.current.add(activeVaultId);
                  rememberCurrentSession(activeVaultId);
                }
              }}
              onAssignmentsChange={(assignments) => {
                setTabGroupAssignments(assignments);
                assignmentsRef.current = assignments;
                if (activeVaultId) {
                  visitedVaults.current.add(activeVaultId);
                  rememberCurrentSession(activeVaultId);
                }
              }}
              onMoveTab={onMoveTab}
              onMoveGroup={onMoveGroup}
              vaultId={activeVaultId}
            />
          }
        />
      </div>
      {pickerOpen && (
        <FilePicker
          entries={matchingNotes}
          highlightedIndex={highlightedIndex}
          query={query}
          hasVault={Boolean(vaultPath)}
          inputRef={pickerInputRef}
          activeVaultId={activeVaultId}
          preview={pickerPreview}
          previewState={pickerPreviewState}
          highlightedEntry={highlightedNote}
          appearance={appearance}
          onQueryChange={(value) => {
            setQuery(value);
            setHighlightedIndex(0);
          }}
          onHighlight={setHighlightedIndex}
          onOpen={openPickerEntry}
          onOpenWikiNote={(target, fromPath) => openWikiNote(target, fromPath)}
          onClose={() => setPickerOpen(false)}
        />
      )}
      {creation && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/20 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !creationPending)
              setCreation(null);
          }}
        >
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-title"
            onSubmit={submitCreation}
            className="app-popup-surface command-palette-surface w-full max-w-sm p-5"
          >
            <h2 id="create-title" className="mb-3 text-lg font-semibold">
              New {creation.kind === 'note' ? 'Markdown note' : 'folder'}
            </h2>
            <p className="mb-4 truncate text-xs text-white/55">
              In {creation.vaultName}
              {creation.parent ? ` / ${creation.parent}` : ''}
            </p>
            <label className="block text-sm">
              Name
              <input
                autoFocus
                value={creationName}
                onChange={(event) => setCreationName(event.target.value)}
                className="app-input mt-1 w-full px-3 py-2 outline-none focus-visible:border-blue-400"
              />
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={creationPending}
                onClick={() => setCreation(null)}
                className="app-button px-3 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                disabled={creationPending || !creationName.trim()}
                className="app-button bg-blue-600 px-3 py-2 text-sm text-white disabled:opacity-50"
              >
                {creationPending ? 'Creating…' : 'Create'}
              </button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <ToastProvider>
    <App />
  </ToastProvider>,
);

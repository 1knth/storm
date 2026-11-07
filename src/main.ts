import { enumerateStudyScope } from './main/studyContextEnumeration';
import { registerSettingsIpc } from './main/registerSettingsIpc';
import { registerShutdownTracking } from './main/shutdownTracking';
import { registerVaultIpc } from './main/registerVaultIpc';
import { configureWindowSecurity } from './main/windowSecurity';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain as electronIpcMain,
  Menu,
  shell,
} from 'electron';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import started from 'electron-squirrel-startup';
import { VaultService } from './vault/vaultService';
import { VaultRegistry } from './vault/vaultRegistry';
import { QuizStore } from './main/quizStore';
import { QuizDeletionBlocked, QuizService } from './main/quizService';
import { LearnerStore, learnerScopeKey } from './main/learnerStore';
import { isQuizConfidence } from './shared/quizProtocol';
import { StudyContextService } from './main/studyContextService';
import { StudyContextStore } from './main/studyContextStore';
import { readStudySource } from './vault/studySourceReader';
import { STUDY_LIMITS } from './shared/studyContext';

app.setName('Storm');
// Keep the pre-branding lowercase data directory so existing vault settings survive.
if (!app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', path.join(app.getPath('appData'), 'storm'));
}
import { VaultWriteBarrier } from './vault/writeBarrier';
import { discoverVaultNotes, resolveVaultLink } from './main/vaultDiscovery';
import { confirmQuitAndFlush } from './quitConfirmation';
import { VaultWatcher } from './vault/vaultWatcher';
import { registerVaultRegistryIpc } from './main/registerVaultRegistryIpc';
import { AgentBroker } from './main/agentBroker';
import { createQuizAgentHandler } from './main/quizAgentHandler';
import { runVaultLifecycleExclusive } from './main/vaultLifecycle';
import { createTutorNotesFile } from './main/tutorNotesFile';
import { bindAgentBrokerIpc, registerAgentIpc } from './main/registerAgentIpc';
import { rendererAuthorizer, trustedIpc } from './main/rendererSecurity';
import {
  resolveAgentNoteTarget,
  resolveExistingAgentNoteTarget,
} from './vault/agentNoteTarget';
import {
  startAgentEndpoint,
  type StartedAgentEndpoint,
} from './main/agentEndpoint';

const vaultService = new VaultService();
const vaultRegistry = new VaultRegistry(app.getPath('userData'));
const quizStore = new QuizStore(
  path.join(app.getPath('userData'), 'quiz-sessions.json'),
);
const learnerStore = new LearnerStore(
  path.join(app.getPath('userData'), 'learner-model.json'),
);
const quizService = new QuizService(
  quizStore,
  async (scope) => {
    const { vaults } = await vaultRegistry.list();
    const vault = vaults.find((entry) => entry.id === scope.vaultId);
    if (
      !vault ||
      !Array.isArray(scope.selectedNotePaths) ||
      scope.selectedNotePaths.length > 1000
    )
      return false;
    const root = await realpath(vault.path).catch(() => null);
    if (!root) return false;
    const contained = async (
      relative: string | null,
      kind: 'file' | 'directory',
    ) => {
      if (relative === null) return true;
      // "." is the explicit vault-root folder scope used by shared study context.
      if (relative === '.' && kind === 'directory') return true;
      if (
        !relative ||
        path.isAbsolute(relative) ||
        relative
          .split(/[\\/]/)
          .some((part) => !part || part === '.' || part === '..')
      )
        return false;
      const resolved = await realpath(path.resolve(root, relative)).catch(
        () => null,
      );
      if (
        !resolved ||
        (resolved !== root && !resolved.startsWith(root + path.sep))
      )
        return false;
      const stat = await import('node:fs/promises')
        .then(({ stat }) => stat(resolved))
        .catch(() => null);
      return !!stat && (kind === 'file' ? stat.isFile() : stat.isDirectory());
    };
    return (
      (await contained(scope.notePath, 'file')) &&
      (await contained(scope.folderPath, 'directory')) &&
      scope.selectedNotePaths.every(
        (item) => typeof item === 'string' && item.length <= 4096,
      ) &&
      (
        await Promise.all(
          scope.selectedNotePaths.map((item) => contained(item, 'file')),
        )
      ).every(Boolean)
    );
  },
  undefined,
  (session, snapshotId, operationId) =>
    studyContext.pinQuestion(
      `pending:${session.id}:${operationId}`,
      snapshotId,
      session.scope,
    ),
  (sessionId, basis, operationId, revision) =>
    studyStore.finalizeQuestion(
      sessionId,
      basis,
      `pending:${sessionId}:${operationId}`,
      revision,
    ),
  (session, question) => learnerStore.recordQuestion(session, question),
  (entries) => learnerStore.recordGrades(entries),
  createTutorNotesFile({
    vaults: async () => (await vaultRegistry.list()).vaults,
    exclusive: (root, operation) =>
      runVaultLifecycleExclusive(root, () => vaultWriteBarrier.run(operation)),
  }),
  (session) =>
    learnerStore.attempts(learnerScopeKey(session.scope, session.id)),
);
let shutdownAllowed = false;
let quitConfirmationInFlight = false;
const vaultWriteBarrier = new VaultWriteBarrier();
let activeWatchedVaultId: string | null = null;
const agentVaults = new Map<
  string,
  { service: VaultService; vaultId: string }
>();
const vaultWatcher = new VaultWatcher((vaultId, revision) => {
  const window = BrowserWindow.getAllWindows().find(
    (candidate) => !candidate.isDestroyed(),
  );
  if (window && !window.webContents.isDestroyed())
    window.webContents.send('vault:changed', { vaultId, revision });
});
async function watchSelectedVault(): Promise<string | null> {
  const selectedPath = vaultService.getSelectedVaultPath();
  if (!selectedPath) {
    vaultWatcher.stop();
    activeWatchedVaultId = null;
    return null;
  }
  const { vaults } = await vaultRegistry.list();
  const vault = vaults.find((entry) => entry.path === selectedPath);
  if (!vault) throw new Error('Selected vault is not registered');
  if (activeWatchedVaultId !== vault.id) {
    activeWatchedVaultId = vault.id;
    vaultWatcher.start(selectedPath, vault.id);
  }
  return vault.id;
}
function invalidateSelectedVault(vaultId: string): void {
  if (vaultId === activeWatchedVaultId) vaultWatcher.invalidate(vaultId);
}
let agentWindow: BrowserWindow | undefined;
let agentAcceptedUrl: string | undefined;
let agentBroker: AgentBroker | undefined;
const authorizeRenderer = rendererAuthorizer(
  () => agentWindow,
  () => agentAcceptedUrl,
);
const ipcMain = trustedIpc(electronIpcMain, authorizeRenderer);
const agentTransport = registerAgentIpc(
  electronIpcMain,
  () => agentWindow,
  () => undefined,
  () => agentAcceptedUrl,
  (ready) => {
    if (ready) agentBroker?.rendererReady();
    else agentBroker?.rendererUnavailable();
  },
);
const studyStore = new StudyContextStore(
  path.join(app.getPath('userData'), 'study-context.json'),
);
const studyStartup = quizStore
  .list()
  .then((questions) => studyStore.reconcileQuestions(questions));
// A failed context store must not tear down ordinary quiz/conversation recovery.
void studyStartup.catch(() => {});
const studyContext = new StudyContextService(studyStore, {
  vaults: async () => (await vaultRegistry.list()).vaults,
  entries: async (root, scope) =>
    enumerateStudyScope(root, scope, async (folder) => {
      const service = new VaultService();
      await service.selectVault(folder);
      return service.listNotes({
        previews: false,
        limit: STUDY_LIMITS.entries + 1,
      });
    }),
  live: async (vaultId, relativePath) => {
    const result = await agentTransport.dispatch({
      type: 'inspect',
      requestId: randomUUID(),
      vaultId,
      path: relativePath,
    });
    if (!result.ok || !('inspected' in result))
      throw new Error('STUDY_RENDERER_UNAVAILABLE');
    return result.open
      ? { text: result.content, saveState: result.saveState }
      : null;
  },
  capture: (root, operation) =>
    runVaultLifecycleExclusive(root, () => vaultWriteBarrier.run(operation)),
  read: readStudySource,
});
agentBroker = new AgentBroker({
  study: async (request) => {
    await studyStartup;
    return studyContext.execute(request);
  },
  resolveTarget: async (notePath) => {
    const { vaults } = await vaultRegistry.list();
    return resolveAgentNoteTarget(notePath, vaults);
  },
  resolveExistingTarget: async (notePath) => {
    const { vaults } = await vaultRegistry.list();
    return resolveExistingAgentNoteTarget(notePath, vaults);
  },
  assertTargetRegistered: async (target) => {
    const { vaults } = await vaultRegistry.list();
    if (
      !vaults.some(
        (vault) =>
          vault.path === target.vaultRoot && vault.id === target.vaultId,
      )
    )
      throw new Error('Vault is not registered');
  },
  withVaultLifecycle: runVaultLifecycleExclusive,
  renderer: agentTransport,
  quiz: createQuizAgentHandler(
    quizService,
    (scope, sessionId) => learnerStore.state(scope, sessionId),
    app.getVersion(),
  ),
  discover: async (vaultId, query, limit, options) =>
    discoverVaultNotes(
      () => vaultRegistry.list(),
      vaultId,
      query,
      limit,
      options,
    ),
  resolveLink: async (vaultId, sourcePath, target) =>
    resolveVaultLink(() => vaultRegistry.list(), vaultId, sourcePath, target),
  getContext: async () => {
    const result = await agentTransport.dispatch({
      type: 'context',
      requestId: randomUUID(),
    });
    if (!result.ok || !('context' in result))
      throw Object.assign(
        new Error(result.ok ? 'Invalid context response' : result.message),
        {
          code: 'CONTEXT_UNAVAILABLE',
        },
      );
    return result.context;
  },
});
const removeAgentBrokerIpc = bindAgentBrokerIpc(
  electronIpcMain,
  agentBroker,
  () => agentWindow,
  () => agentAcceptedUrl,
);
app.on('will-quit', () => {
  quizService.disposeImages();
  removeAgentBrokerIpc();
  agentTransport.dispose?.();
});
const quizPublicSession = (
  session: import('./shared/quizProtocol').QuizSession,
) => {
  const { agentToken: _agentToken, ...publicSession } = session;
  return publicSession;
};
const isQuizScopeInput = (scope: unknown) => {
  if (scope === undefined) return true;
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return false;
  const value = scope as Record<string, unknown>;
  return (
    typeof value.vaultId === 'string' &&
    (value.notePath === null || typeof value.notePath === 'string') &&
    (value.folderPath === null || typeof value.folderPath === 'string') &&
    Array.isArray(value.selectedNotePaths) &&
    value.selectedNotePaths.every((item) => typeof item === 'string')
  );
};
ipcMain.handle('quiz:create', async (event, scope?: unknown) => {
  if (!isQuizScopeInput(scope)) return { ok: false, error: 'invalid-input' };
  const result = await quizService.createSession(
    scope as import('./shared/quizProtocol').QuizScope | undefined,
  );
  return result.ok
    ? { ...result, value: quizPublicSession(result.value) }
    : result;
});
ipcMain.handle('quiz:set-scope', async (event, id: unknown, scope: unknown) => {
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    id.length > 128 ||
    !isQuizScopeInput(scope ?? undefined)
  )
    return { ok: false, error: 'invalid-input' };
  const result = await quizService.setScope(
    id,
    (scope ?? undefined) as
      | import('./shared/quizProtocol').QuizScope
      | undefined,
  );
  return result.ok
    ? { ...result, value: quizPublicSession(result.value) }
    : result;
});
ipcMain.handle('quiz:rename', async (event, id: unknown, name: unknown) => {
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    id.length > 128 ||
    typeof name !== 'string' ||
    name.trim().length === 0 ||
    name.trim().length > 100
  )
    return { ok: false, error: 'invalid-input' };
  const result = await quizService.renameSession(id, name);
  return result.ok
    ? { ...result, value: quizPublicSession(result.value) }
    : result;
});
ipcMain.handle('quiz:stop-agent', async (event, id: unknown) => {
  if (typeof id !== 'string' || id.length === 0 || id.length > 128)
    return { ok: false, error: 'invalid-input' };
  const result = await quizService.stopAgent(id);
  return result.ok
    ? { ...result, value: quizPublicSession(result.value) }
    : result;
});
ipcMain.handle('quiz:delete', async (event, id: unknown) => {
  if (typeof id !== 'string' || id.length === 0 || id.length > 128)
    return { ok: false, error: 'invalid-input' };
  try {
    return { ok: true, value: await quizService.deleteSession(id) };
  } catch (error) {
    if (error instanceof QuizDeletionBlocked)
      return { ok: false, error: error.message };
    throw error;
  }
});
ipcMain.handle('quiz:list', async () => quizService.listSessionSummaries());
ipcMain.handle('quiz:snapshot', async (event, id: unknown, after: unknown) => {
  const snapshot =
    typeof id === 'string' &&
    (after === undefined || (Number.isSafeInteger(after) && Number(after) >= 0))
      ? await quizService.getSnapshot(
          id,
          after === undefined ? 0 : Number(after),
        )
      : null;
  return snapshot
    ? { ...snapshot, session: quizPublicSession(snapshot.session) }
    : null;
});
ipcMain.handle(
  'quiz:draft',
  async (event, id: unknown, revision: unknown, draft: unknown) => {
    if (
      typeof id !== 'string' ||
      id.length > 128 ||
      !Number.isSafeInteger(revision) ||
      Number(revision) < 0 ||
      !draft ||
      typeof draft !== 'object' ||
      Array.isArray(draft)
    )
      return { ok: false, error: 'invalid-input' };
    const value = draft as Record<string, unknown>;
    if (
      !(
        value.questionId === null ||
        (typeof value.questionId === 'string' && value.questionId.length <= 128)
      ) ||
      !(
        value.selectedChoiceId === null ||
        (typeof value.selectedChoiceId === 'string' &&
          value.selectedChoiceId.length <= 128)
      ) ||
      typeof value.reasoningDraft !== 'string' ||
      typeof value.freeChatDraft !== 'string' ||
      (value.matchesDraft !== undefined &&
        (!value.matchesDraft ||
          typeof value.matchesDraft !== 'object' ||
          Array.isArray(value.matchesDraft) ||
          Object.keys(value.matchesDraft).length > 12 ||
          Object.entries(value.matchesDraft).some(
            ([key, val]) =>
              !key ||
              key.length > 128 ||
              typeof val !== 'string' ||
              !val ||
              val.length > 128,
          ))) ||
      (value.textDraft !== undefined &&
        (typeof value.textDraft !== 'string' ||
          value.textDraft.length > 20000)) ||
      (value.promptId !== undefined &&
        (typeof value.promptId !== 'string' || value.promptId.length > 128)) ||
      (value.selectedPromptChoiceId !== undefined &&
        (typeof value.selectedPromptChoiceId !== 'string' ||
          value.selectedPromptChoiceId.length > 128)) ||
      (value.promptDetailDraft !== undefined &&
        (typeof value.promptDetailDraft !== 'string' ||
          value.promptDetailDraft.length > 20000)) ||
      new TextEncoder().encode(value.reasoningDraft).byteLength > 65536 ||
      new TextEncoder().encode(value.freeChatDraft).byteLength > 65536
    )
      return { ok: false, error: 'invalid-input' };
    const result = await quizService.saveDraft(
      id,
      Number(revision),
      value as import('./shared/quizProtocol').QuizDraft,
    );
    return result.ok
      ? { ...result, value: quizPublicSession(result.value) }
      : result;
  },
);
ipcMain.handle(
  'quiz:image-add',
  async (event, sessionId: unknown, input: unknown) => {
    if (
      typeof sessionId !== 'string' ||
      sessionId.length === 0 ||
      sessionId.length > 128 ||
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input)
    )
      return { ok: false, error: 'invalid-input' };
    const image = input as Record<string, unknown>;
    if (
      typeof image.mimeType !== 'string' ||
      !(image.data instanceof Uint8Array)
    )
      return { ok: false, error: 'invalid-input' };
    return quizService.addImage(sessionId, {
      mimeType: image.mimeType,
      data: image.data,
    });
  },
);
ipcMain.handle(
  'quiz:image-remove',
  async (event, sessionId: unknown, id: unknown) => {
    if (typeof sessionId !== 'string' || typeof id !== 'string')
      return { ok: false, error: 'invalid-input' };
    return { ok: true, value: await quizService.removeImage(sessionId, id) };
  },
);
ipcMain.handle('quiz:learner-request', async (event, value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { ok: false, error: 'invalid-input' };
  const request = value as Record<string, unknown>;
  if (
    !['answer', 'message', 'continue', 'respond-prompt', 'skip'].includes(
      String(request.type),
    ) ||
    typeof request.sessionId !== 'string' ||
    request.sessionId.length > 128 ||
    typeof request.idempotencyKey !== 'string' ||
    request.idempotencyKey.length > 128 ||
    !request.idempotencyKey.trim() ||
    !Number.isSafeInteger(request.expectedRevision) ||
    Number(request.expectedRevision) < 0
  )
    return { ok: false, error: 'invalid-input' };
  if (request.type === 'answer') {
    const optionalString = (key: string, max: number) =>
      request[key] === undefined ||
      (typeof request[key] === 'string' && String(request[key]).length <= max);
    const matches = request.matches;
    if (
      !optionalString('choiceId', 128) ||
      !optionalString('reasoning', 65536) ||
      !optionalString('answer', 20000) ||
      (request.confidence !== undefined &&
        !isQuizConfidence(request.confidence)) ||
      (matches !== undefined &&
        (!matches ||
          typeof matches !== 'object' ||
          Array.isArray(matches) ||
          Object.keys(matches).length > 12 ||
          Object.entries(matches).some(
            ([key, val]) =>
              !key ||
              key.length > 128 ||
              typeof val !== 'string' ||
              !val ||
              val.length > 128,
          ))) ||
      (typeof request.reasoning === 'string' &&
        new TextEncoder().encode(request.reasoning).byteLength > 65536)
    )
      return { ok: false, error: 'invalid-input' };
  }
  if (
    request.type === 'respond-prompt' &&
    (typeof request.promptId !== 'string' ||
      !request.promptId ||
      request.promptId.length > 128 ||
      typeof request.choiceId !== 'string' ||
      !request.choiceId ||
      request.choiceId.length > 128 ||
      (request.detail !== undefined &&
        (typeof request.detail !== 'string' || request.detail.length > 20000)))
  )
    return { ok: false, error: 'invalid-input' };
  if (
    request.type === 'message' &&
    ((request.text !== undefined &&
      (typeof request.text !== 'string' ||
        new TextEncoder().encode(request.text).byteLength > 65536)) ||
      (request.attachments !== undefined &&
        (!Array.isArray(request.attachments) ||
          request.attachments.length > 4 ||
          request.attachments.some(
            (id) => typeof id !== 'string' || id.length > 128,
          ))))
  )
    return { ok: false, error: 'invalid-input' };
  const result = await quizService.learnerRequest(
    request as import('./shared/quizProtocol').QuizLearnerRequest,
  );
  return result.ok
    ? { ...result, value: quizPublicSession(result.value) }
    : result;
});
ipcMain.handle('agent:save-note', async (_event, request: unknown) => {
  if (!request || typeof request !== 'object' || Array.isArray(request))
    throw new Error('Invalid save request');
  const value = request as Record<string, unknown>;
  if (
    typeof value.vaultPath !== 'string' ||
    typeof value.path !== 'string' ||
    typeof value.content !== 'string' ||
    typeof value.revision !== 'string'
  )
    throw new Error('Invalid save request');
  return vaultWriteBarrier.run(async () => {
    const root = await realpath(value.vaultPath as string);
    const { vaults } = await vaultRegistry.list();
    const vault = vaults.find((entry) => entry.path === root);
    if (!vault) throw new Error('Vault is not registered');
    let owned = agentVaults.get(root);
    if (!owned) {
      const service = new VaultService();
      await service.selectVault(root);
      owned = { service, vaultId: vault.id };
      agentVaults.set(root, owned);
    }
    const result = await owned.service.saveNote({ ...value, vaultPath: root });
    invalidateSelectedVault(owned.vaultId);
    return result;
  });
});

const closeAllowed = new WeakSet<BrowserWindow>();
let openFileMenuItem: Electron.MenuItem | null = null;
let toggleExplorerMenuItem: Electron.MenuItem | null = null;
const sendIndexedShortcut = (
  channel: 'tabs:select-index' | 'vaults:activate-index',
  index: number,
) => {
  BrowserWindow.getFocusedWindow()?.webContents.send(channel, index);
};

ipcMain.on(
  'shortcut:set-enabled',
  (_event, shortcut: unknown, enabled: unknown) => {
    if (typeof enabled !== 'boolean') return;
    if (shortcut === 'openFile' && openFileMenuItem)
      openFileMenuItem.enabled = enabled;
    if (shortcut === 'toggleExplorer' && toggleExplorerMenuItem)
      toggleExplorerMenuItem.enabled = enabled;
  },
);

const flushBeforeQuit = registerShutdownTracking(ipcMain);

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

const createWindow = () => {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    // Keep the native macOS titlebar and traffic lights; a transparent window can
    // suppress the standard titlebar, so translucency comes from vibrancy instead.
    vibrancy: 'hud',
    visualEffectState: 'active',
    frame: true,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  configureWindowSecurity(mainWindow, () => agentAcceptedUrl);

  agentWindow = mainWindow;
  mainWindow.on('closed', () => {
    if (agentWindow === mainWindow) agentWindow = undefined;
    vaultWatcher.stop();
    activeWatchedVaultId = null;
  });

  mainWindow.on('close', (event) => {
    if (shutdownAllowed || closeAllowed.has(mainWindow)) return;
    event.preventDefault();
    void flushBeforeQuit().then((proceed) => {
      if (proceed && !mainWindow.isDestroyed()) {
        closeAllowed.add(mainWindow);
        mainWindow.close();
      }
    });
  });

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    agentAcceptedUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL;
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    const htmlPath = path.join(
      __dirname,
      `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`,
    );
    agentAcceptedUrl = pathToFileURL(htmlPath).href;
    mainWindow.loadFile(htmlPath);
  }

  // Open the DevTools.
  // mainWindow.webContents.openDevTools();
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
registerVaultIpc(ipcMain, {
  vaultService,
  vaultRegistry,
  vaultWriteBarrier,
  agentBroker,
  watchSelectedVault,
  invalidateSelectedVault,
});

registerVaultRegistryIpc(ipcMain, {
  registry: vaultRegistry,
  service: vaultService,
  writeBarrier: vaultWriteBarrier,
  watchSelectedVault,
  stopWatcher: () => vaultWatcher.stop(),
  clearWatchedVaultId: () => {
    activeWatchedVaultId = null;
  },
  hasWritableAgentSession: (vaultId) =>
    agentBroker.hasWritableSessionForVault(vaultId),
  withVaultLifecycle: runVaultLifecycleExclusive,
  openPath: (directory) => shell.openPath(directory),
  showItemInFolder: (file) => shell.showItemInFolder(file),
});

let agentEndpoint: StartedAgentEndpoint | undefined;
async function closeAgentEndpoint(): Promise<void> {
  const endpoint = agentEndpoint;
  agentEndpoint = undefined;
  await endpoint?.close();
}
app.whenReady().then(async () => {
  agentEndpoint = await startAgentEndpoint({
    broker: agentBroker,
    userDataPath: app.getPath('userData'),
  });
  const menu = Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        {
          label: 'Settings',
          accelerator: 'CommandOrControl+,',
          click: () => {
            const window =
              BrowserWindow.getFocusedWindow() ??
              BrowserWindow.getAllWindows()[0];
            window?.webContents.send('settings:open');
          },
        },
        {
          label: 'New Note',
          accelerator: 'CommandOrControl+N',
          click: () =>
            BrowserWindow.getFocusedWindow()?.webContents.send(
              'entry:create',
              'note',
            ),
        },
        {
          label: 'New Folder',
          accelerator: 'CommandOrControl+Shift+N',
          click: () =>
            BrowserWindow.getFocusedWindow()?.webContents.send(
              'entry:create',
              'folder',
            ),
        },
        {
          label: 'Close Tab',
          accelerator: undefined,
          click: () =>
            BrowserWindow.getFocusedWindow()?.webContents.send(
              'tabs:close-active',
            ),
        },
        {
          label: 'New Tab',
          accelerator: 'CommandOrControl+T',
          click: () => {
            BrowserWindow.getFocusedWindow()?.webContents.send('tabs:new');
          },
        },
        {
          id: 'open-file-shortcut',
          label: 'Open File…',
          accelerator: 'CommandOrControl+P',
          click: () => {
            const window =
              BrowserWindow.getFocusedWindow() ??
              BrowserWindow.getAllWindows()[0];
            window?.webContents.send('file:open');
          },
        },
        {
          label: 'Toggle Reading Mode',
          accelerator: 'CommandOrControl+E',
          click: () => {
            BrowserWindow.getFocusedWindow()?.webContents.send(
              'reading-mode:toggle',
            );
          },
        },
        {
          label: 'Toggle Markdown Preview',
          accelerator: 'CommandOrControl+Shift+M',
          click: () => {
            const window =
              BrowserWindow.getFocusedWindow() ??
              BrowserWindow.getAllWindows()[0];
            window?.webContents.send('preview:toggle');
          },
        },
        {
          id: 'toggle-explorer-shortcut',
          label: 'Toggle File Explorer',
          accelerator: 'CommandOrControl+S',
          click: () => {
            const window =
              BrowserWindow.getFocusedWindow() ??
              BrowserWindow.getAllWindows()[0];
            window?.webContents.send('explorer:toggle');
          },
        },
        { type: 'separator' },
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        {
          label: 'Toggle Quiz',
          accelerator: process.platform === 'darwin' ? 'Command+Q' : undefined,
          click: () => {
            const window =
              BrowserWindow.getFocusedWindow() ??
              BrowserWindow.getAllWindows()[0];
            window?.webContents.send('quiz:toggle');
          },
        },
        {
          label: 'Toggle Quiz Full Screen',
          accelerator: 'CommandOrControl+Shift+F',
          click: () => {
            const window =
              BrowserWindow.getFocusedWindow() ??
              BrowserWindow.getAllWindows()[0];
            window?.webContents.send('quiz:toggle-fullscreen');
          },
        },
        {
          label: 'Quit',
          click: () => app.quit(),
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'Bold',
          accelerator: 'CommandOrControl+B',
          click: () =>
            BrowserWindow.getFocusedWindow()?.webContents.send(
              'editor:format',
              'bold',
            ),
        },
        {
          label: 'Italic',
          accelerator: 'CommandOrControl+I',
          click: () =>
            BrowserWindow.getFocusedWindow()?.webContents.send(
              'editor:format',
              'italic',
            ),
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        ...(['Vaults', 'File Explorer', 'Editor'] as const).map(
          (label, index) => ({
            label: `Focus ${label}`,
            accelerator:
              process.platform === 'darwin'
                ? `Control+${index + 1}`
                : `Alt+${index + 1}`,
            click: () =>
              BrowserWindow.getFocusedWindow()?.webContents.send(
                'pane:focus',
                ['vaults', 'explorer', 'editor'][index],
              ),
          }),
        ),
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Tabs',
      submenu: [
        {
          label: 'Reopen Closed Tab',
          accelerator: 'CommandOrControl+Shift+T',
          click: () =>
            BrowserWindow.getFocusedWindow()?.webContents.send(
              'tabs:reopen-closed',
            ),
        },
        {
          label: 'Restore Saved Tabs',
          click: () =>
            BrowserWindow.getFocusedWindow()?.webContents.send(
              'tabs:restore-saved',
            ),
        },
        { type: 'separator' },
        ...Array.from({ length: 9 }, (_, index) => ({
          label: `Select Tab ${index + 1}`,
          accelerator: `CommandOrControl+${index + 1}`,
          click: () => sendIndexedShortcut('tabs:select-index', index),
        })),
      ],
    },
    {
      label: 'Vaults',
      submenu: Array.from({ length: 9 }, (_, index) => ({
        label: `Activate Vault ${index + 1}`,
        accelerator: `Control+Shift+${index + 1}`,
        click: () => sendIndexedShortcut('vaults:activate-index', index),
      })),
    },
    {
      role: 'window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ]);
  registerSettingsIpc(ipcMain, menu);
  app.applicationMenu = menu;
  openFileMenuItem = menu.getMenuItemById('open-file-shortcut');
  toggleExplorerMenuItem = menu.getMenuItemById('toggle-explorer-shortcut');
  createWindow();

  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', (event) => {
  // Closing the final window is already guarded by its close handler. Don't
  // show a second quit confirmation after that window has been destroyed.
  if (shutdownAllowed || BrowserWindow.getAllWindows().length === 0) {
    shutdownAllowed = true;
    void closeAgentEndpoint().catch((error) =>
      console.error('Unable to close agent endpoint', error),
    );
    return;
  }
  event.preventDefault();
  if (quitConfirmationInFlight) return;
  quitConfirmationInFlight = true;
  void (async () => {
    try {
      const proceed = await confirmQuitAndFlush(async () => {
        const choice = await dialog.showMessageBox({
          ...(BrowserWindow.getFocusedWindow()
            ? { window: BrowserWindow.getFocusedWindow()! }
            : {}),
          type: 'question',
          buttons: ['Cancel', 'Quit'],
          defaultId: 0,
          cancelId: 0,
          message: 'Are you sure you want to quit Storm?',
          noLink: true,
        });
        return choice.response === 1;
      }, flushBeforeQuit);
      if (!proceed) return;
      shutdownAllowed = true;
      await closeAgentEndpoint();
      app.quit();
    } catch (error) {
      console.error('Unable to confirm or prepare application quit', error);
    } finally {
      quitConfirmationInFlight = false;
    }
  })();
});

// Quit the app when its last window is closed on every platform.
app.on('window-all-closed', () => {
  app.quit();
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.

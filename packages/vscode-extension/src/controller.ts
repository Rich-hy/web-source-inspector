import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import * as vscode from 'vscode';

import { BridgeClient, type BridgeConnectionState } from './bridgeClient';
import { formatDiagnostics, redactDiagnosticText, shortSessionId } from './diagnostics';
import {
  disableProject,
  enableProject,
  findProjectCandidateRoots,
  runProjectDoctor,
  viewIntegrationPlan,
} from './projectManagement';
import { detectProjectIntegrationStatus, type ProjectIntegrationStatus } from './projectStatus';
import { createRootMappings } from './rootMapping';
import { discoverSessions, type DiscoveredSession } from './sessionDiscovery';
import { SourceOpener } from './sourceOpener';
import type { BrowserTab, OpenSourceResult, RootMapping, ServerOpenSourcePayload, SourceCandidate } from './types';

const COMMANDS = {
  enableProject: 'sourceInspector.enableProject',
  viewIntegrationPlan: 'sourceInspector.viewIntegrationPlan',
  runDoctor: 'sourceInspector.runDoctor',
  disableProject: 'sourceInspector.disableProject',
  connectSession: 'sourceInspector.connectSession',
  chooseSession: 'sourceInspector.chooseSession',
  toggleBrowserSelectMode: 'sourceInspector.toggleBrowserSelectMode',
  openLastSelection: 'sourceInspector.openLastSelection',
  chooseSourceCandidate: 'sourceInspector.chooseSourceCandidate',
  showDiagnostics: 'sourceInspector.showDiagnostics',
  disconnect: 'sourceInspector.disconnect',
} as const;

const PROJECT_STATUS_CACHE_TTL_MS = 10_000;
const PROJECT_CANDIDATE_SCAN_INTERVAL_MS = 30_000;
const MAXIMUM_PROJECT_STATUS_ROOTS = 200;
const MAXIMUM_PROJECT_STATE_FILES = 100;

interface MatchingSession {
  discovered: DiscoveredSession;
  rootMappings: Map<string, RootMapping>;
}

interface ProjectWorkspaceSnapshot {
  key: string;
  localFolders: vscode.WorkspaceFolder[];
  trustedRoots: string[];
  supported: boolean;
}

interface SessionWorkspaceSnapshot {
  key: string;
  workspaceRoots: string[];
  supported: boolean;
}

type SessionQuickPickItem = vscode.QuickPickItem & { itemType: 'session'; session: MatchingSession };
type TabQuickPickItem = vscode.QuickPickItem & { itemType: 'tab'; tab: BrowserTab };

function configuration(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('sourceInspector');
}

function pageDescription(tab: BrowserTab): string | undefined {
  return tab.pathname || undefined;
}

function resultMessage(result: OpenSourceResult): string {
  switch (result.code) {
    case 'WORKSPACE_NOT_MATCHED':
      return '请求的项目根未映射到当前 workspace。';
    case 'PATH_REJECTED':
      return '源码路径未通过 workspace 安全校验。';
    case 'FILE_NOT_FOUND':
      return '源码文件不存在或不是普通文件。';
    case 'INTERNAL_ERROR':
      return '打开源码时发生内部错误，请查看脱敏诊断。';
    default:
      return `打开源码失败：${result.code}`;
  }
}

export class ExtensionController implements vscode.Disposable {
  private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  private readonly output = vscode.window.createOutputChannel('Web Source Inspector');
  private readonly disposables: vscode.Disposable[] = [];
  private readonly sourceOpener: SourceOpener;
  private matchingSessions: MatchingSession[] = [];
  private bridge: BridgeClient | undefined;
  private currentSession: MatchingSession | undefined;
  private rootMappings = new Map<string, RootMapping>();
  private connectionState: BridgeConnectionState = 'idle';
  private browserTabs: BrowserTab[] = [];
  private selectedPageClientId: string | undefined;
  private lastSelection: ServerOpenSourcePayload | undefined;
  private lastDiagnosticCode: string | undefined;
  private readonly emptyRootMappings = new Map<string, RootMapping>();
  private sessionRefreshPromise: Promise<void> | undefined;
  private sessionRefreshGeneration = 0;
  private sessionRefreshAutoConnectRequested = false;
  private sessionWorkspaceKey = '';
  private rootMappingsGeneration = -1;
  private disposed = false;
  private manuallyDisconnected = false;
  private ideClientId = '';
  private projectStatus: ProjectIntegrationStatus = 'not-installed';
  private projectCandidateRoots: string[] = [];
  private projectCandidateScannedAt = 0;
  private projectStatusWorkspaceKey = '';
  private projectStatusRefreshedAt = 0;
  private projectStatusInvalidationVersion = 0;
  private projectStatusRefreshPromise: Promise<void> | undefined;

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.sourceOpener = new SourceOpener({
      getRootMappings: () => this.currentRootMappings(),
      enableContextRelocation: () => configuration().get('enableContextRelocation', true),
      openMode: () => configuration().get<'permanent' | 'preview'>('openMode', 'permanent'),
      revealPosition: () =>
        configuration().get<'center' | 'centerIfOutside' | 'top'>('revealPosition', 'centerIfOutside'),
    });
  }

  public async activate(): Promise<void> {
    // 服务端以 ideClientId 区分编辑器窗口；每次 Extension Host 激活都使用独立身份。
    this.disposed = false;
    this.ideClientId = randomUUID();

    this.statusBar.command = COMMANDS.chooseSession;
    this.statusBar.name = 'Web Source Inspector';
    this.statusBar.show();
    this.disposables.push(this.statusBar, this.output);
    this.registerCommands();
    this.disposables.push(
      vscode.window.onDidChangeWindowState((state) => this.bridge?.setFocused(state.focused)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.disconnect(false);
        void this.refreshProjectStatus(true);
        void this.refreshSessions(true, true);
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('sourceInspector')) {
          this.updateStatusBar();
        }
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        void this.refreshProjectStatus(true);
        void this.refreshSessions(true, true);
      }),
    );

    const pollingTimer = setInterval(() => {
      void this.refreshProjectStatus();
      void this.refreshSessions(true);
    }, 3_000);
    this.disposables.push({ dispose: () => clearInterval(pollingTimer) });
    this.updateStatusBar();
    await this.refreshProjectStatus(true);
    await this.refreshSessions(true, true);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.invalidateSessionRefresh();
    this.disconnect(false);
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  private registerCommands(): void {
    const register = (command: string, callback: () => unknown): void => {
      this.disposables.push(vscode.commands.registerCommand(command, callback));
    };
    register(COMMANDS.enableProject, async () => {
      await enableProject();
      await this.refreshProjectStatus(true);
    });
    register(COMMANDS.viewIntegrationPlan, () => viewIntegrationPlan());
    register(COMMANDS.runDoctor, async () => {
      await runProjectDoctor();
      await this.refreshProjectStatus(true);
    });
    register(COMMANDS.disableProject, async () => {
      await disableProject();
      await this.refreshProjectStatus(true);
    });
    register(COMMANDS.connectSession, () => this.connectSession());
    register(COMMANDS.chooseSession, () => this.chooseSessionOrTab());
    register(COMMANDS.toggleBrowserSelectMode, () => this.toggleBrowserSelectMode());
    register(COMMANDS.openLastSelection, () => this.openLastSelection());
    register(COMMANDS.chooseSourceCandidate, () => this.chooseSourceCandidate());
    register(COMMANDS.showDiagnostics, () => this.showDiagnostics());
    register(COMMANDS.disconnect, () => this.disconnect(true));
  }

  private isRemote(): boolean {
    return typeof vscode.env.remoteName === 'string' && vscode.env.remoteName.length > 0;
  }

  private ensureSupported(showMessage: boolean): boolean {
    if (this.disposed) {
      return false;
    }
    if (!vscode.workspace.isTrusted) {
      if (showMessage) {
        void vscode.window.showWarningMessage('Source Inspector：当前 workspace 未受信任，连接和打开源码均已禁用。');
      }
      return false;
    }
    if (this.isRemote()) {
      if (showMessage) {
        void vscode.window.showWarningMessage('Source Inspector：首版不支持 WSL、SSH、Dev Container 或其它 Remote 环境。');
      }
      return false;
    }
    if (!(vscode.workspace.workspaceFolders ?? []).some((folder) => folder.uri.scheme === 'file')) {
      if (showMessage) {
        void vscode.window.showWarningMessage('Source Inspector：请先打开本地 workspace。');
      }
      return false;
    }
    return true;
  }

  private sessionWorkspaceSnapshot(): SessionWorkspaceSnapshot {
    const localFolders = (vscode.workspace.workspaceFolders ?? [])
      .filter((folder) => folder.uri.scheme === 'file');
    const remoteName = typeof vscode.env.remoteName === 'string' ? vscode.env.remoteName : '';
    return {
      key: [
        vscode.workspace.isTrusted ? 'trusted' : 'untrusted',
        remoteName || 'local',
        ...localFolders.map((folder) => folder.uri.toString()),
      ].join('\u0000'),
      workspaceRoots: localFolders.map((folder) => folder.uri.fsPath),
      supported: vscode.workspace.isTrusted && remoteName.length === 0 && localFolders.length > 0,
    };
  }

  private invalidateSessionRefresh(): void {
    this.sessionRefreshGeneration += 1;
    this.matchingSessions = [];
  }

  private synchronizeSessionWorkspace(snapshot: SessionWorkspaceSnapshot): boolean {
    if (snapshot.key === this.sessionWorkspaceKey) {
      return false;
    }
    this.sessionWorkspaceKey = snapshot.key;
    this.invalidateSessionRefresh();
    if (this.currentSession || this.bridge) {
      this.disconnect(false);
    }
    return true;
  }

  private isSessionContextCurrent(
    generation: number,
    workspaceKey: string,
    requireSupported: boolean,
  ): boolean {
    if (this.disposed
      || generation !== this.sessionRefreshGeneration
      || workspaceKey !== this.sessionWorkspaceKey) {
      return false;
    }
    const snapshot = this.sessionWorkspaceSnapshot();
    return snapshot.key === workspaceKey && (!requireSupported || snapshot.supported);
  }

  private refreshSessions(allowAutoConnect: boolean, force = false): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    const snapshot = this.sessionWorkspaceSnapshot();
    const workspaceChanged = this.synchronizeSessionWorkspace(snapshot);
    if (force && !workspaceChanged) {
      this.invalidateSessionRefresh();
    }
    this.sessionRefreshAutoConnectRequested ||= allowAutoConnect;
    if (this.sessionRefreshPromise) {
      return this.sessionRefreshPromise;
    }

    // workspace/trust 变化只递增 generation；当前任务结束后统一补跑，不并发发现会话。
    const refreshPromise = this.runSessionRefreshLoop().finally(() => {
      if (this.sessionRefreshPromise === refreshPromise) {
        this.sessionRefreshPromise = undefined;
      }
    });
    this.sessionRefreshPromise = refreshPromise;
    return refreshPromise;
  }

  private async runSessionRefreshLoop(): Promise<void> {
    while (!this.disposed) {
      const refreshGeneration = this.sessionRefreshGeneration;
      const allowAutoConnect = this.sessionRefreshAutoConnectRequested;
      this.sessionRefreshAutoConnectRequested = false;
      await this.refreshSessionsOnce(refreshGeneration, allowAutoConnect);
      if (this.disposed) {
        return;
      }
      if (refreshGeneration !== this.sessionRefreshGeneration) {
        continue;
      }
      if (this.sessionRefreshAutoConnectRequested && !allowAutoConnect) {
        continue;
      }
      this.sessionRefreshAutoConnectRequested = false;
      return;
    }
  }

  private async refreshSessionsOnce(refreshGeneration: number, allowAutoConnect: boolean): Promise<void> {
    const snapshot = this.sessionWorkspaceSnapshot();
    if (this.synchronizeSessionWorkspace(snapshot)) {
      return;
    }
    if (!snapshot.supported) {
      if (this.isSessionContextCurrent(refreshGeneration, snapshot.key, false)) {
        this.matchingSessions = [];
        this.updateStatusBar();
      }
      return;
    }

    const discovered = await discoverSessions({
      userId: typeof process.getuid === 'function' ? process.getuid() : undefined,
    });
    const matching = await Promise.all(
      discovered.map(async (session): Promise<MatchingSession | undefined> => {
        const rootMappings = await createRootMappings(session.descriptor.canonicalRoots, snapshot.workspaceRoots);
        return rootMappings.size > 0 ? { discovered: session, rootMappings } : undefined;
      }),
    );
    const latestSnapshot = this.sessionWorkspaceSnapshot();
    if (this.synchronizeSessionWorkspace(latestSnapshot)
      || !this.isSessionContextCurrent(refreshGeneration, snapshot.key, true)) {
      return;
    }

    this.matchingSessions = matching.filter((session): session is MatchingSession => session !== undefined);
    if (this.currentSession) {
      const refreshedCurrentSession = this.matchingSessions.find(
        (session) => session.discovered.descriptor.sessionId === this.currentSession?.discovered.descriptor.sessionId,
      );
      if (!refreshedCurrentSession) {
        this.lastDiagnosticCode = 'SESSION_EXPIRED';
        this.disconnect(false);
      } else {
        this.currentSession = refreshedCurrentSession;
        this.rootMappings = refreshedCurrentSession.rootMappings;
        this.rootMappingsGeneration = refreshGeneration;
      }
    }
    if (
      allowAutoConnect &&
      !this.bridge &&
      !this.manuallyDisconnected &&
      configuration().get('autoConnect', true) &&
      this.matchingSessions.length === 1
    ) {
      const onlySession = this.matchingSessions[0];
      if (onlySession && this.isSessionContextCurrent(refreshGeneration, snapshot.key, true)) {
        this.connectTo(onlySession, refreshGeneration);
      }
    }
    if (this.isSessionContextCurrent(refreshGeneration, snapshot.key, true)) {
      this.updateStatusBar();
    }
  }

  private currentRootMappings(): ReadonlyMap<string, RootMapping> {
    if (!this.currentSession
      || !this.isSessionContextCurrent(this.rootMappingsGeneration, this.sessionWorkspaceKey, true)) {
      return this.emptyRootMappings;
    }
    return this.rootMappings;
  }

  private projectWorkspaceSnapshot(): ProjectWorkspaceSnapshot {
    const localFolders = (vscode.workspace.workspaceFolders ?? [])
      .filter((folder) => folder.uri.scheme === 'file');
    const trustedRoots = localFolders.map((folder) => folder.uri.fsPath);
    const remoteName = typeof vscode.env.remoteName === 'string' ? vscode.env.remoteName : '';
    return {
      key: [
        vscode.workspace.isTrusted ? 'trusted' : 'untrusted',
        remoteName || 'local',
        ...localFolders.map((folder) => folder.uri.toString()),
      ].join('\u0000'),
      localFolders,
      trustedRoots,
      supported: vscode.workspace.isTrusted && remoteName.length === 0 && trustedRoots.length > 0,
    };
  }

  private invalidateProjectStatus(clearCandidates: boolean): void {
    this.projectStatusInvalidationVersion += 1;
    this.projectStatusRefreshedAt = 0;
    if (clearCandidates) {
      this.projectCandidateRoots = [];
      this.projectCandidateScannedAt = 0;
    }
  }

  private synchronizeProjectWorkspace(snapshot: ProjectWorkspaceSnapshot): boolean {
    if (snapshot.key === this.projectStatusWorkspaceKey) {
      return false;
    }
    this.projectStatusWorkspaceKey = snapshot.key;
    this.invalidateProjectStatus(true);
    return true;
  }

  private refreshProjectStatus(force = false): Promise<void> {
    const snapshot = this.projectWorkspaceSnapshot();
    const workspaceChanged = this.synchronizeProjectWorkspace(snapshot);
    if (force && !workspaceChanged) {
      this.invalidateProjectStatus(true);
    }

    const now = Date.now();
    const cacheFresh = now - this.projectStatusRefreshedAt < PROJECT_STATUS_CACHE_TTL_MS;
    const candidateScanDue = snapshot.supported
      && now - this.projectCandidateScannedAt >= PROJECT_CANDIDATE_SCAN_INTERVAL_MS;
    if (!this.projectStatusRefreshPromise && !force && !workspaceChanged && cacheFresh && !candidateScanDue) {
      return Promise.resolve();
    }
    if (this.projectStatusRefreshPromise) {
      return this.projectStatusRefreshPromise;
    }

    // 所有触发源复用同一任务；刷新期间的强制失效由版本号合并为一次补跑。
    const refreshPromise = this.runProjectStatusRefreshLoop().finally(() => {
      if (this.projectStatusRefreshPromise === refreshPromise) {
        this.projectStatusRefreshPromise = undefined;
      }
    });
    this.projectStatusRefreshPromise = refreshPromise;
    return refreshPromise;
  }

  private async runProjectStatusRefreshLoop(): Promise<void> {
    while (true) {
      const refreshVersion = this.projectStatusInvalidationVersion;
      try {
        await this.refreshProjectStatusOnce(refreshVersion);
      } catch {
        if (refreshVersion === this.projectStatusInvalidationVersion) {
          this.projectStatus = 'conflict';
          this.projectStatusRefreshedAt = Date.now();
          this.updateStatusBar();
        }
      }
      if (refreshVersion === this.projectStatusInvalidationVersion) {
        return;
      }
    }
  }

  private async refreshProjectStatusOnce(refreshVersion: number): Promise<void> {
    const snapshot = this.projectWorkspaceSnapshot();
    if (this.synchronizeProjectWorkspace(snapshot)) {
      return;
    }
    if (!snapshot.supported) {
      if (refreshVersion === this.projectStatusInvalidationVersion) {
        this.projectCandidateRoots = [];
        this.projectCandidateScannedAt = 0;
        this.projectStatus = 'not-installed';
        this.projectStatusRefreshedAt = Date.now();
        this.updateStatusBar();
      }
      return;
    }

    const now = Date.now();
    const shouldScanCandidates = now - this.projectCandidateScannedAt >= PROJECT_CANDIDATE_SCAN_INTERVAL_MS;
    const candidateRoots = shouldScanCandidates
      ? await this.scanProjectCandidateRoots(snapshot)
      : this.projectCandidateRoots;
    const candidateScannedAt = shouldScanCandidates ? Date.now() : this.projectCandidateScannedAt;
    const stateRoots = await this.scanProjectStateRoots(snapshot.localFolders);
    const projectRoots = this.boundedProjectRoots(snapshot.trustedRoots, stateRoots, candidateRoots);
    const projectStatus = await detectProjectIntegrationStatus(projectRoots, snapshot.trustedRoots);

    const latestSnapshot = this.projectWorkspaceSnapshot();
    if (this.synchronizeProjectWorkspace(latestSnapshot)
      || latestSnapshot.key !== snapshot.key
      || refreshVersion !== this.projectStatusInvalidationVersion) {
      return;
    }
    this.projectCandidateRoots = candidateRoots;
    this.projectCandidateScannedAt = candidateScannedAt;
    this.projectStatus = projectStatus;
    this.projectStatusRefreshedAt = Date.now();
    this.updateStatusBar();
  }

  private async scanProjectCandidateRoots(snapshot: ProjectWorkspaceSnapshot): Promise<string[]> {
    const candidateRoots: string[] = [];
    const seenRoots = new Set(snapshot.trustedRoots);
    let remainingRoots = Math.max(0, MAXIMUM_PROJECT_STATUS_ROOTS - seenRoots.size);
    for (const folder of snapshot.localFolders) {
      if (remainingRoots === 0) {
        break;
      }
      try {
        const roots = await findProjectCandidateRoots(folder, remainingRoots);
        for (const root of roots) {
          if (!seenRoots.has(root)) {
            seenRoots.add(root);
            candidateRoots.push(root);
            remainingRoots -= 1;
            if (remainingRoots === 0) {
              break;
            }
          }
        }
      } catch {
        continue;
      }
    }
    return candidateRoots;
  }

  private async scanProjectStateRoots(localFolders: readonly vscode.WorkspaceFolder[]): Promise<string[]> {
    const stateRoots: string[] = [];
    let remainingFiles = MAXIMUM_PROJECT_STATE_FILES;
    for (const folder of localFolders) {
      if (remainingFiles === 0) {
        break;
      }
      try {
        const stateFiles = await vscode.workspace.findFiles(
          new vscode.RelativePattern(folder, '**/.web-source-inspector.json'),
          new vscode.RelativePattern(folder, '**/{node_modules,.git,dist,build,coverage}/**'),
          remainingFiles,
        );
        remainingFiles -= stateFiles.length;
        stateRoots.push(...stateFiles.map((stateFile) => path.dirname(stateFile.fsPath)));
      } catch {
        continue;
      }
    }
    return [...new Set(stateRoots)];
  }

  private boundedProjectRoots(...rootGroups: readonly string[][]): string[] {
    const roots: string[] = [];
    const seenRoots = new Set<string>();
    for (const group of rootGroups) {
      for (const root of group) {
        if (!seenRoots.has(root)) {
          seenRoots.add(root);
          roots.push(root);
          if (roots.length === MAXIMUM_PROJECT_STATUS_ROOTS) {
            return roots;
          }
        }
      }
    }
    return roots;
  }

  private async connectSession(): Promise<void> {
    if (!this.ensureSupported(true)) {
      return;
    }
    this.manuallyDisconnected = false;
    await this.refreshSessions(false);
    if (!this.ensureSupported(false)) {
      return;
    }
    const selectionGeneration = this.sessionRefreshGeneration;
    if (this.matchingSessions.length === 0) {
      void vscode.window.showInformationMessage('Source Inspector：未发现与当前 workspace 匹配的开发会话。');
      return;
    }
    const selected =
      this.matchingSessions.length === 1
        ? this.matchingSessions[0]
        : await vscode.window.showQuickPick(this.sessionQuickPickItems(), {
            placeHolder: '选择要连接的本地开发会话',
          });
    if (!selected) {
      return;
    }
    this.connectTo('itemType' in selected ? selected.session : selected, selectionGeneration);
  }

  private connectTo(session: MatchingSession, expectedGeneration = this.sessionRefreshGeneration): void {
    const sessionId = session.discovered.descriptor.sessionId;
    if (!this.isSessionContextCurrent(expectedGeneration, this.sessionWorkspaceKey, true)
      || !this.matchingSessions.some((item) => item.discovered.descriptor.sessionId === sessionId)) {
      return;
    }
    this.disconnect(false);
    this.manuallyDisconnected = false;
    this.currentSession = session;
    this.rootMappings = session.rootMappings;
    this.rootMappingsGeneration = expectedGeneration;
    this.browserTabs = [];
    this.selectedPageClientId = undefined;
    const extensionVersion = String(this.context.extension.packageJSON.version ?? '0.0.0');
    const workspaceRoots = [...session.rootMappings.values()].flatMap((mapping) =>
      mapping.workspaceRoots.map((canonicalPath) => ({
        rootKey: mapping.rootKey,
        canonicalPath,
      })),
    );
    this.bridge = new BridgeClient({
      descriptor: session.discovered.descriptor,
      identity: {
        ideClientId: this.ideClientId,
        ideName: this.ideKind() === 'cursor' ? 'Cursor' : 'VS Code',
        extensionVersion,
      },
      workspaceRoots,
      capabilities: ['open-source', 'source-digest', 'context-relocation', 'browser-mode', 'multi-root'],
      autoClaim: configuration().get('autoClaimFocusedWindow', true),
      focused: vscode.window.state.focused,
      onStateChange: (state) => {
        this.connectionState = state;
        this.updateStatusBar();
      },
      onTabsChanged: (tabs) => {
        this.browserTabs = tabs;
        if (this.selectedPageClientId && !tabs.some((tab) => tab.pageClientId === this.selectedPageClientId)) {
          this.selectedPageClientId = undefined;
        }
        this.updateStatusBar();
      },
      onOpenSource: (payload) => this.handleOpenSource(payload),
      onDiagnostic: (code) => this.recordDiagnostic(code),
    });
    this.connectionState = 'connecting';
    this.bridge.start();
    this.updateStatusBar();
  }

  private async handleOpenSource(payload: ServerOpenSourcePayload): Promise<OpenSourceResult> {
    if (this.disposed || !this.ensureSupported(false) || !this.currentSession) {
      return { openRequestId: payload.openRequestId, success: false, code: 'WORKSPACE_NOT_MATCHED' };
    }
    const result = await this.sourceOpener.open(payload);
    this.lastDiagnosticCode = result.code;
    if (result.success) {
      this.lastSelection = payload;
      this.selectedPageClientId = payload.pageClientId;
    }
    this.updateStatusBar();
    return result;
  }

  private async chooseSessionOrTab(): Promise<void> {
    if (!this.ensureSupported(true)) {
      return;
    }
    await this.refreshSessions(false);
    if (!this.ensureSupported(false)) {
      return;
    }
    const selectionGeneration = this.sessionRefreshGeneration;
    const items: Array<SessionQuickPickItem | TabQuickPickItem> = [
      ...this.browserTabs.map((tab): TabQuickPickItem => ({
        itemType: 'tab',
        tab,
        label: `$(browser) ${tab.title?.trim() || 'Browser tab'}`,
        description: pageDescription(tab),
        detail: tab.pageClientId === this.selectedPageClientId ? '当前目标 tab' : undefined,
      })),
      ...this.sessionQuickPickItems(),
    ];
    if (items.length === 0) {
      void vscode.window.showInformationMessage('Source Inspector：没有可选择的 session 或 browser tab。');
      return;
    }
    const selected = await vscode.window.showQuickPick(items, { placeHolder: '选择开发 session 或 browser tab' });
    if (!selected) {
      return;
    }
    if (selected.itemType === 'session') {
      this.connectTo(selected.session, selectionGeneration);
    } else {
      if (!this.isSessionContextCurrent(selectionGeneration, this.sessionWorkspaceKey, true)) {
        return;
      }
      this.selectedPageClientId = selected.tab.pageClientId;
      this.bridge?.choosePage(selected.tab.pageClientId);
      this.updateStatusBar();
    }
  }

  private sessionQuickPickItems(): SessionQuickPickItem[] {
    return this.matchingSessions.map((session) => {
      const descriptor = session.discovered.descriptor;
      return {
        itemType: 'session',
        session,
        label: `$(server) ${descriptor.projectName}`,
        description: `session ${shortSessionId(descriptor.sessionId)}`,
        detail:
          descriptor.sessionId === this.currentSession?.discovered.descriptor.sessionId ? '当前连接' : '本机 loopback 会话',
      };
    });
  }

  private async chooseTargetTabIfNeeded(): Promise<boolean> {
    if (this.selectedPageClientId || this.browserTabs.length <= 1) {
      if (!this.selectedPageClientId && this.browserTabs[0]) {
        this.selectedPageClientId = this.browserTabs[0].pageClientId;
        this.bridge?.choosePage(this.selectedPageClientId);
      }
      return true;
    }
    const selected = await vscode.window.showQuickPick(
      this.browserTabs.map((tab) => ({
        label: tab.title?.trim() || 'Browser tab',
        description: pageDescription(tab),
        tab,
      })),
      { placeHolder: '选择要控制的 browser tab' },
    );
    if (!selected) {
      return false;
    }
    this.selectedPageClientId = selected.tab.pageClientId;
    this.bridge?.choosePage(this.selectedPageClientId);
    return true;
  }

  private async toggleBrowserSelectMode(): Promise<void> {
    if (!this.ensureSupported(true) || !this.bridge) {
      void vscode.window.showInformationMessage('Source Inspector：请先连接本地 Vite 会话。');
      return;
    }
    if (!(await this.chooseTargetTabIfNeeded())) {
      return;
    }
    if (!this.bridge.toggleBrowserSelectMode()) {
      void vscode.window.showWarningMessage('Source Inspector：Bridge 尚未就绪，请稍后重试。');
    }
  }

  private async openLastSelection(): Promise<void> {
    if (!this.ensureSupported(true) || !this.lastSelection) {
      void vscode.window.showInformationMessage('Source Inspector：当前没有可重新打开的可信选择。');
      return;
    }
    const result = await this.sourceOpener.open(this.lastSelection);
    if (!result.success) {
      void vscode.window.showWarningMessage(`Source Inspector：${resultMessage(result)}`);
    }
  }

  private async chooseSourceCandidate(): Promise<void> {
    if (!this.ensureSupported(true) || !this.lastSelection) {
      void vscode.window.showInformationMessage('Source Inspector：当前没有源码候选。');
      return;
    }
    const primaryCandidate: SourceCandidate = {
      candidateKind: this.lastSelection.candidateKind,
      label: this.lastSelection.componentName || this.lastSelection.tagName || this.lastSelection.candidateKind,
      rootKey: this.lastSelection.rootKey,
      relativePath: this.lastSelection.relativePath,
      range: this.lastSelection.range,
      sourceDigest: this.lastSelection.sourceDigest,
      contextBefore: this.lastSelection.contextBefore,
      contextAfter: this.lastSelection.contextAfter,
      accuracy: this.lastSelection.accuracy,
    };
    const uniqueCandidates = new Map<string, SourceCandidate>();
    for (const candidate of [primaryCandidate, ...this.lastSelection.candidates]) {
      const key = [
        candidate.rootKey,
        candidate.relativePath,
        candidate.range.startOffset,
        candidate.range.endOffset,
        candidate.candidateKind,
      ].join(':');
      uniqueCandidates.set(key, candidate);
    }
    const selected = await vscode.window.showQuickPick(
      [...uniqueCandidates.values()].map((candidate, index) => ({
        label: candidate.label,
        description: `${candidate.relativePath}:${candidate.range.startLine}`,
        detail: `${candidate.accuracy} · ${candidate.candidateKind}`,
        candidate,
        index,
      })),
      { placeHolder: '选择元素、组件调用点或控制流候选' },
    );
    if (!selected) {
      return;
    }
    const { label: _label, ...candidateLocation } = selected.candidate;
    const payload: ServerOpenSourcePayload = {
      ...this.lastSelection,
      ...candidateLocation,
      openRequestId: `${this.lastSelection.openRequestId}.candidate.${selected.index}`,
    };
    const result = await this.sourceOpener.open(payload);
    if (result.success) {
      this.lastSelection = payload;
    } else {
      void vscode.window.showWarningMessage(`Source Inspector：${resultMessage(result)}`);
    }
  }

  private showDiagnostics(): void {
    const descriptor = this.currentSession?.discovered.descriptor;
    const diagnostics = formatDiagnostics({
      extensionVersion: String(this.context.extension.packageJSON.version ?? '0.0.0'),
      ideKind: this.ideKind(),
      trusted: vscode.workspace.isTrusted,
      remote: this.isRemote(),
      connectionState: this.connectionState,
      ...(descriptor
        ? {
            sessionId: descriptor.sessionId,
            projectName: descriptor.projectName,
            protocolVersion: descriptor.protocolVersion,
          }
        : {}),
      matchingRootCount: this.rootMappings.size,
      browserTabCount: this.browserTabs.length,
      ...(this.lastDiagnosticCode ? { lastCode: this.lastDiagnosticCode } : {}),
    });
    this.output.clear();
    this.output.appendLine(redactDiagnosticText(diagnostics, os.homedir()));
    this.output.show(true);
  }

  private recordDiagnostic(code: string): void {
    this.lastDiagnosticCode = /^[A-Z0-9_:-]{1,80}$/u.test(code) ? code : 'UNKNOWN_DIAGNOSTIC';
    if (configuration().get('debugLog', false)) {
      this.output.appendLine(`[${new Date().toISOString()}] ${this.lastDiagnosticCode}`);
    }
    this.updateStatusBar();
  }

  private disconnect(manual: boolean): void {
    this.manuallyDisconnected = manual;
    this.bridge?.dispose();
    this.bridge = undefined;
    this.currentSession = undefined;
    this.rootMappings = new Map();
    this.rootMappingsGeneration = -1;
    this.browserTabs = [];
    this.selectedPageClientId = undefined;
    this.connectionState = 'idle';
    this.updateStatusBar();
  }

  private ideKind(): 'vscode' | 'cursor' {
    return vscode.env.appName.toLocaleLowerCase('en-US').includes('cursor') ? 'cursor' : 'vscode';
  }

  private updateStatusBar(): void {
    if (!vscode.workspace.isTrusted) {
      this.statusBar.text = '$(shield) Source Inspector：Workspace 未信任';
      this.statusBar.tooltip = '未连接；受信后才允许发现会话和打开源码';
      return;
    }
    if (this.isRemote()) {
      this.statusBar.text = '$(remote) Source Inspector：Remote 不支持';
      this.statusBar.tooltip = '首版仅支持 Dev Server、Extension Host 和源码位于同一台本机';
      return;
    }
    if (this.currentSession) {
      this.statusBar.command = COMMANDS.chooseSession;
      const project = this.currentSession.discovered.descriptor.projectName;
      if (this.connectionState === 'rejected' || this.connectionState === 'expired') {
        this.statusBar.text = '$(error) Source Inspector：连接被拒绝';
      } else if (this.connectionState === 'connecting' || this.connectionState === 'reconnecting') {
        this.statusBar.text = `$(sync~spin) Source Inspector：${project}`;
      } else if (
        this.connectionState === 'authenticated' ||
        this.connectionState === 'claimed' ||
        this.connectionState === 'active'
      ) {
        this.statusBar.text = `$(debug-alt) Source Inspector：${project}`;
      } else {
        this.statusBar.text = `$(plug) Source Inspector：${project}`;
      }
      const currentTab = this.browserTabs.find((tab) => tab.pageClientId === this.selectedPageClientId);
      this.statusBar.tooltip = currentTab?.title ? `当前 browser tab：${currentTab.title}` : `状态：${this.connectionState}`;
      return;
    }
    if (this.matchingSessions.length > 0) {
      this.statusBar.command = COMMANDS.chooseSession;
      this.statusBar.text = `$(plug) Source Inspector：发现 ${this.matchingSessions.length} 个会话`;
      this.statusBar.tooltip = '点击选择并连接本地开发会话';
      return;
    }
    this.statusBar.command = COMMANDS.enableProject;
    if (this.projectStatus === 'conflict') {
      this.statusBar.command = COMMANDS.runDoctor;
      this.statusBar.text = '$(error) Source Inspector：项目配置冲突';
      this.statusBar.tooltip = '点击运行 Doctor';
    } else if (this.projectStatus === 'not-installed') {
      this.statusBar.text = '$(package) Source Inspector：npm 包未安装';
      this.statusBar.tooltip = '安装 web-source-inspector 后点击启用项目';
    } else if (this.projectStatus === 'not-enabled') {
      this.statusBar.text = '$(circle-slash) Source Inspector：项目未启用';
      this.statusBar.tooltip = '点击预览并应用项目接入计划';
    } else {
      this.statusBar.text = '$(watch) Source Inspector：等待开发服务';
      this.statusBar.tooltip = '项目已启用，请运行原有 dev 命令';
    }
  }
}

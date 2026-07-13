import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RootMapping } from './types';

const mocks = vi.hoisted(() => ({
  bridgeInstances: [] as Array<{ start: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }>,
  createRootMappings: vi.fn(),
  discoverSessions: vi.fn(),
  sourceOpenerOptions: undefined as { getRootMappings: () => ReadonlyMap<string, RootMapping> } | undefined,
  trusted: true,
  workspaceFolders: [] as Array<{ name: string; index: number; uri: { scheme: string; fsPath: string; toString(): string } }>,
}));

vi.mock('vscode', () => ({
  StatusBarAlignment: { Left: 1 },
  Uri: {
    file: (fsPath: string) => ({ scheme: 'file', fsPath, toString: () => `file://${fsPath}` }),
  },
  commands: {
    registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
  },
  env: {
    appName: 'Visual Studio Code',
    remoteName: undefined,
  },
  window: {
    createOutputChannel: vi.fn(() => ({
      appendLine: vi.fn(),
      clear: vi.fn(),
      dispose: vi.fn(),
      show: vi.fn(),
    })),
    createStatusBarItem: vi.fn(() => ({
      command: undefined,
      dispose: vi.fn(),
      name: '',
      show: vi.fn(),
      text: '',
      tooltip: '',
    })),
    onDidChangeWindowState: vi.fn(() => ({ dispose: vi.fn() })),
    state: { focused: true },
  },
  workspace: {
    get isTrusted() {
      return mocks.trusted;
    },
    get workspaceFolders() {
      return mocks.workspaceFolders;
    },
    getConfiguration: vi.fn(() => ({ get: vi.fn((_key: string, defaultValue: unknown) => defaultValue) })),
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
    onDidChangeWorkspaceFolders: vi.fn(() => ({ dispose: vi.fn() })),
    onDidGrantWorkspaceTrust: vi.fn(() => ({ dispose: vi.fn() })),
  },
}));

vi.mock('./bridgeClient', () => ({
  BridgeClient: class {
    public readonly start = vi.fn();
    public readonly dispose = vi.fn();

    public constructor() {
      mocks.bridgeInstances.push(this);
    }
  },
}));

vi.mock('./projectManagement', () => ({
  disableProject: vi.fn(),
  enableProject: vi.fn(),
  findProjectCandidateRoots: vi.fn(),
  runProjectDoctor: vi.fn(),
  viewIntegrationPlan: vi.fn(),
}));

vi.mock('./projectStatus', () => ({
  detectProjectIntegrationStatus: vi.fn(),
}));

vi.mock('./rootMapping', () => ({
  createRootMappings: mocks.createRootMappings,
}));

vi.mock('./sessionDiscovery', () => ({
  discoverSessions: mocks.discoverSessions,
}));

vi.mock('./sourceOpener', () => ({
  SourceOpener: class {
    public constructor(options: { getRootMappings: () => ReadonlyMap<string, RootMapping> }) {
      mocks.sourceOpenerOptions = options;
    }
  },
}));

import { ExtensionController } from './controller';

interface ControllerInternals {
  dispose(): void;
  matchingSessions: unknown[];
  refreshSessions(allowAutoConnect: boolean, force?: boolean): Promise<void>;
}

function folder(name: string, fsPath: string, index = 0) {
  return {
    name,
    index,
    uri: { scheme: 'file', fsPath, toString: () => `file://${fsPath}` },
  };
}

function session() {
  return {
    descriptorPath: 'session.json',
    descriptor: {
      sessionId: 'session-12345678',
      projectName: 'fixture',
      canonicalRoots: [{ rootKey: 'fixture', canonicalPath: 'C:\\old', displayName: 'fixture' }],
      protocolVersion: 1,
    },
  };
}

function deferred<T>() {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function createController(): ControllerInternals {
  return new ExtensionController({ extension: { packageJSON: { version: '0.1.0' } } } as never) as unknown as ControllerInternals;
}

describe('ExtensionController session refresh', () => {
  beforeEach(() => {
    mocks.bridgeInstances.length = 0;
    mocks.createRootMappings.mockReset();
    mocks.discoverSessions.mockReset();
    mocks.sourceOpenerOptions = undefined;
    mocks.trusted = true;
    mocks.workspaceFolders = [folder('old', 'C:\\old')];
  });

  it('discards an old workspace refresh and coalesces one forced rerun', async () => {
    const firstDiscovery = deferred<ReturnType<typeof session>[]>();
    mocks.discoverSessions
      .mockReturnValueOnce(firstDiscovery.promise)
      .mockResolvedValueOnce([]);
    mocks.createRootMappings.mockResolvedValue(new Map([
      ['fixture', { rootKey: 'fixture', sessionRoot: 'C:\\old', workspaceRoots: ['C:\\old'] }],
    ]));
    const controller = createController();

    const firstRefresh = controller.refreshSessions(true);
    mocks.workspaceFolders = [folder('new', 'C:\\new')];
    const forcedRefresh = controller.refreshSessions(true, true);
    firstDiscovery.resolve([session()]);
    await Promise.all([firstRefresh, forcedRefresh]);

    expect(mocks.discoverSessions).toHaveBeenCalledTimes(2);
    expect(controller.matchingSessions).toEqual([]);
    expect(mocks.bridgeInstances).toHaveLength(0);
  });

  it('does not commit or reconnect after disposal', async () => {
    const discovery = deferred<ReturnType<typeof session>[]>();
    mocks.discoverSessions.mockReturnValueOnce(discovery.promise);
    mocks.createRootMappings.mockResolvedValue(new Map([
      ['fixture', { rootKey: 'fixture', sessionRoot: 'C:\\old', workspaceRoots: ['C:\\old'] }],
    ]));
    const controller = createController();

    const refresh = controller.refreshSessions(true);
    controller.dispose();
    discovery.resolve([session()]);
    await refresh;

    expect(controller.matchingSessions).toEqual([]);
    expect(mocks.bridgeInstances).toHaveLength(0);
  });

  it('stops exposing mappings as soon as the workspace key changes', async () => {
    mocks.discoverSessions.mockResolvedValue([session()]);
    mocks.createRootMappings.mockResolvedValue(new Map([
      ['fixture', { rootKey: 'fixture', sessionRoot: 'C:\\old', workspaceRoots: ['C:\\old'] }],
    ]));
    const controller = createController();

    await controller.refreshSessions(true);
    expect(mocks.sourceOpenerOptions?.getRootMappings().size).toBe(1);

    mocks.workspaceFolders = [folder('new', 'C:\\new')];
    expect(mocks.sourceOpenerOptions?.getRootMappings().size).toBe(0);
  });
});

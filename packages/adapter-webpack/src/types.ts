import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

import type {
  SourceIdGenerator,
  SourceManifest,
  SourceManifestStage,
  SourceRecord,
} from '@web-source-inspector/compiler-core';
import type { VueCompilerAdapter } from '@web-source-inspector/transform-vue';
import type {
  BrowserRouter,
  LoopbackBridge,
} from '@web-source-inspector/dev-session-core';

import type { WebpackSourceBoundary } from './source-boundary.js';

export type VueLoaderMajor = 15 | 16 | 17;

export interface WebpackLoaderEntry {
  loader?: string;
  options?: unknown;
  ident?: string;
  [key: string]: unknown;
}

export interface WebpackRuleLike {
  loader?: string;
  options?: unknown;
  use?: string | WebpackLoaderEntry | Array<string | WebpackLoaderEntry>;
  rules?: WebpackRuleLike[];
  oneOf?: WebpackRuleLike[];
  [key: string]: unknown;
}

export interface WebpackModuleLike {
  buildInfo?: Record<string, unknown>;
  buildMeta?: Record<string, unknown>;
  loaders?: readonly { loader?: string }[];
  resource?: string;
  identifier?: () => string;
  [key: string]: unknown;
}

export interface WebpackCompilationLike {
  hooks?: {
    finishModules?: {
      tap(name: string, callback: (modules: Iterable<WebpackModuleLike>) => void): void;
    };
  };
  modules?: Iterable<WebpackModuleLike>;
  errors: Error[];
  [key: string]: unknown;
}

export interface WebpackStatsLike {
  compilation?: WebpackCompilationLike;
  hasErrors(): boolean;
}

export interface WebpackCompilerLike {
  options?: {
    mode?: string;
    context?: string;
    entry?: WebpackEntryLike;
    module?: { rules?: WebpackRuleLike[] };
    plugins?: unknown[];
    [key: string]: unknown;
  };
  compilers?: WebpackCompilerLike[];
  context?: string;
  version?: string;
  webpack?: { version?: string; EntryPlugin?: unknown };
  inputFileSystem?: WebpackInputFileSystem;
  hooks?: {
    afterPlugins?: {
      tap(name: string, callback: (compiler: WebpackCompilerLike) => void): void;
    };
    thisCompilation?: {
      tap(name: string, callback: (compilation: WebpackCompilationLike) => void): void;
    };
    done?: {
      tap(name: string, callback: (stats: WebpackStatsLike) => void): void;
    };
    failed?: {
      tap(name: string, callback: (error: Error) => void): void;
    };
    invalid?: {
      tap(name: string, callback: () => void): void;
    };
    watchClose?: {
      tap(name: string, callback: () => void): void;
    };
    shutdown?: {
      tap(name: string, callback: () => void): void;
    };
    watchRun?: {
      tapPromise?(name: string, callback: () => Promise<void>): void;
      tapAsync?(
        name: string,
        callback: (compiler: WebpackCompilerLike, done: (error?: Error) => void) => void,
      ): void;
    };
  };
  [key: string]: unknown;
}

export interface WebpackInputFileSystem {
  readFile(
    filename: string,
    callback: (error: NodeJS.ErrnoException | null, data?: Buffer | string) => void,
  ): void;
}

export interface WebpackBrowserClientContext {
  pageClientId: string;
  connectionId: string;
  readonly remoteAddress: string | null;
  send(event: string, payload: unknown): void;
  isOpen(): boolean;
}

export interface WebpackBrowserMessageHandler {
  onConnect?(client: WebpackBrowserClientContext): void | Promise<void>;
  onMessage?(payload: unknown, client: WebpackBrowserClientContext): void | Promise<void>;
  onDisconnect?(client: WebpackBrowserClientContext): void | Promise<void>;
}

export interface WebSourceInspectorWebpackPluginOptions {
  /** 项目根目录，仅用于解析 Webpack、vue-loader 与 Vue compiler。 */
  projectRoot?: string;
  /** @deprecated 请改用 projectRoot。 */
  root?: string;
  /** 可定位源码与 Manifest 的 workspace 根目录；省略时自动向上发现。 */
  workspaceRoot?: string;
  rootKey?: string;
  vueVersion?: string;
  vueLoaderMajor?: VueLoaderMajor;
  vueCompiler?: VueCompilerAdapter;
  allowedOrigins?: readonly string[];
  browserMessageHandler?: WebpackBrowserMessageHandler;
  runtimeModuleRequest?: string;
  browserTransport?: 'wds' | 'raw' | 'none';
  bridge?: boolean;
  diagnostics?: (message: string) => void;
}

export type WebpackEntryValue =
  | string
  | string[]
  | {
      import: string | string[];
      [key: string]: unknown;
    };

export type WebpackEntryLike =
  | WebpackEntryValue
  | Record<string, WebpackEntryValue>
  | ((...arguments_: unknown[]) => unknown);

export interface WsiRuntimeBootstrapOptions {
  sessionId: string;
  sessionEpoch: string;
  browserToken: string;
  runtimeModuleRequest: string;
  transport:
    | { kind: 'wds'; basePath: string }
    | { kind: 'raw'; port: number; path: string };
}

export interface WsiLoaderIdentity {
  schemaVersion: number;
  sessionEpoch: string;
  compilerSessionId: string;
  adapterVersion: string;
  compilerVersion: string;
  vueLoaderMajor: VueLoaderMajor;
  loaderPath: string;
}

export interface WsiBuildMetadata extends WsiLoaderIdentity {
  moduleId: string;
  fullDigest: string;
  generation: number;
  records: SourceRecord[];
}

export interface CompilationBuildState {
  buildId: number;
  compilationId: string;
  compilation: WebpackCompilationLike;
  stage: SourceManifestStage;
  moduleIds: Set<string>;
  metadataCollected: boolean;
}

export interface BrowserTransportCredential {
  basePath: string;
  browserToken: string;
  allowedOrigins: readonly string[] | null;
  observedOrigins: Set<string>;
}

export interface WebpackAdapterSession {
  readonly compiler: WebpackCompilerLike;
  readonly compilerSessionId: string;
  readonly sessionEpoch: string;
  readonly sessionSourceKey: Buffer;
  readonly compilerVersion: string;
  readonly vueLoaderMajor: VueLoaderMajor;
  readonly projectRoot: string;
  readonly workspaceRoot: string;
  readonly sourceBoundary: WebpackSourceBoundary;
  readonly rootKey: string;
  readonly manifest: SourceManifest;
  readonly createSourceId: SourceIdGenerator;
  readonly loaderIdentity: WsiLoaderIdentity;
  readonly vueVersion: string | undefined;
  readonly vueCompiler: VueCompilerAdapter | undefined;
  readonly browserMessageHandler: WebpackBrowserMessageHandler | undefined;
  readonly browserRouter: BrowserRouter | null;
  readonly bridgeEnabled: boolean;
  readonly diagnostics: ((message: string) => void) | undefined;
  readonly browserCredential: BrowserTransportCredential | null;
  readonly wdsCredential: BrowserTransportCredential | null;
  readonly rawCredential: BrowserTransportCredential | null;
  nextBuildId: number;
  currentBuild: CompilationBuildState | null;
  successfulModuleIds: Set<string>;
  middleware: ConnectMiddleware | null;
  disposeMiddleware: (() => void) | null;
  bridge: LoopbackBridge | null;
  bridgeStartPromise: Promise<void> | null;
  browserSweepTimer: ReturnType<typeof setInterval> | null;
  rawServer: RawWatchServer | null;
  rawStartPromise: Promise<void> | null;
  runtimeInjected: boolean;
  disposed: boolean;
}

export type ConnectNext = (error?: unknown) => void;

export type ConnectMiddleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: ConnectNext,
) => void;

export interface RawLoopbackTransportDescriptor {
  path: string;
  browserToken: string;
  allowedOrigins: readonly string[];
}

export interface RawLoopbackBrowserTransport {
  readonly descriptor: RawLoopbackTransportDescriptor;
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  broadcast(event: string, payload: unknown): void;
  dispose(): void;
}

export interface RawWatchServer {
  readonly port: number;
  readonly transport: RawLoopbackBrowserTransport;
  dispose(): Promise<void>;
}

export interface RawLoopbackBrowserTransportOptions {
  allowedOrigins: readonly string[];
  browserMessageHandler?: WebpackBrowserMessageHandler;
  maximumMessageBytes?: number;
  connectionCapacity?: number;
  credential?: {
    path: string;
    browserToken: string;
  };
}

export interface WebpackLoaderItemLike {
  path?: string;
  request?: string;
}

export type WebpackLoaderCallback = (
  error: Error | null,
  content?: string | Buffer,
  sourceMap?: unknown,
  additionalData?: unknown,
) => void;

export interface WebpackLoaderContextLike {
  resourcePath: string;
  resourceQuery?: string;
  rootContext?: string;
  loaderIndex: number;
  loaders: WebpackLoaderItemLike[];
  _compiler?: WebpackCompilerLike;
  _module?: WebpackModuleLike;
  fs?: WebpackInputFileSystem;
  query?: unknown;
  async?(): WebpackLoaderCallback | undefined;
  getOptions?(): unknown;
  cacheable?(cacheable?: boolean): void;
  emitWarning?(warning: Error): void;
}

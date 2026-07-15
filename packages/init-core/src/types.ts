export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'yarn-pnp' | 'unknown';
export type BundlerKind = 'vite' | 'webpack' | 'vue-cli' | 'ambiguous' | 'unsupported';
export type AdapterKind = 'vite-vue2' | 'vite-vue3' | 'webpack-vue2' | 'webpack-vue3';
export type ConfigModuleKind = 'esm' | 'commonjs' | 'typescript';
export type ProjectTransport = 'vite' | 'wds' | 'raw-watch' | 'ambiguous' | 'unknown';
export type VueFamily = 'vue-2.6' | 'vue-2.7' | 'vue-3';

export interface DetectedPackage {
  name: string;
  version: string;
  packageJsonPath: string;
}

export interface DevCommandCandidate {
  scriptName: string;
  command: string;
  bundler: 'vite' | 'webpack' | 'vue-cli';
  continuous: boolean;
}

export type ProjectDiagnosticSeverity = 'info' | 'warning' | 'error';

export interface ProjectDiagnostic {
  code: string;
  severity: ProjectDiagnosticSeverity;
  message: string;
  blocking: boolean;
}

export interface RequiredInput {
  questionId: string;
  type: 'choice' | 'origin';
  message: string;
  choices?: string[];
}

export interface ProjectProfile {
  schemaVersion: 1;
  workspaceRoot: string;
  packageManager: PackageManager;
  packageManifest: string;
  vue?: DetectedPackage;
  vite?: DetectedPackage;
  viteVuePlugin?: DetectedPackage;
  webpack?: DetectedPackage;
  vueCliService?: DetectedPackage;
  vueLoader?: DetectedPackage;
  vueCompiler?: DetectedPackage;
  vueCompilerDom?: DetectedPackage;
  webpackDevServer?: DetectedPackage;
  toolchain?: {
    vueFamily?: VueFamily;
    viteMajor?: number;
    vueLoaderMajor?: number;
    webpackDevServerMajor?: number;
    transport: ProjectTransport;
  };
  bundler: BundlerKind;
  adapter?: AdapterKind;
  devCommands: DevCommandCandidate[];
  configFiles: Array<{
    path: string;
    moduleKind: ConfigModuleKind;
  }>;
  diagnostics: ProjectDiagnostic[];
  requiredInputs: RequiredInput[];
  blocked: boolean;
}

export interface DetectProjectOptions {
  workspaceRoot: string;
  answers?: Readonly<Record<string, string>>;
}

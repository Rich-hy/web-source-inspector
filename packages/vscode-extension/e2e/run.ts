import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { downloadAndUnzipVSCode } from '@vscode/test-electron';

const TEMPORARY_PREFIX = 'wsi-vscode-e2e-';
const TEST_TIMEOUT_MS = 180_000;

type Scenario = 'trusted' | 'untrusted';

interface ScenarioPaths {
  root: string;
  workspace: string;
  userData: string;
  extensions: string;
  temporaryDirectory: string;
}

function extensionRoot(): string {
  return path.resolve(__dirname, '..');
}

async function resolveVSCodeExecutable(packageRoot: string): Promise<string> {
  const configuredExecutable = process.env.VSCODE_EXECUTABLE_PATH;
  if (configuredExecutable) {
    return path.resolve(configuredExecutable);
  }

  return downloadAndUnzipVSCode({
    version: process.env.VSCODE_VERSION ?? '1.110.0',
    cachePath: path.join(packageRoot, '.vscode-test'),
    extensionDevelopmentPath: packageRoot,
  });
}

async function createScenarioPaths(temporaryRoot: string, scenario: Scenario): Promise<ScenarioPaths> {
  const root = path.join(temporaryRoot, scenario);
  const workspace = path.join(root, 'workspace');
  const userData = path.join(root, 'user-data');
  const extensions = path.join(root, 'extensions');
  const temporaryDirectory = path.join(root, 'tmp');

  await Promise.all([
    fs.mkdir(path.join(workspace, 'src'), { recursive: true }),
    fs.mkdir(path.join(userData, 'User'), { recursive: true }),
    fs.mkdir(extensions, { recursive: true }),
    fs.mkdir(temporaryDirectory, { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(
      path.join(workspace, 'src', 'App.vue'),
      '<template>\n  <button>Save</button>\n</template>\n',
      'utf8',
    ),
    fs.writeFile(
      path.join(userData, 'User', 'settings.json'),
      JSON.stringify(
        {
          'security.workspace.trust.startupPrompt': 'never',
          'security.workspace.trust.banner': 'never',
          'workbench.startupEditor': 'none',
        },
        null,
        2,
      ),
      'utf8',
    ),
  ]);

  return { root, workspace, userData, extensions, temporaryDirectory };
}

function stopProcess(child: ChildProcess): void {
  if (!child.pid) {
    return;
  }
  if (process.platform === 'win32') {
    spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  child.kill('SIGTERM');
}

async function runScenario(
  executablePath: string,
  packageRoot: string,
  paths: ScenarioPaths,
  scenario: Scenario,
): Promise<void> {
  const suitePath = path.join(packageRoot, 'dist', 'suite.js');
  const launchArguments = [
    paths.workspace,
    '--new-window',
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--disable-updates',
    '--disable-extensions',
    '--skip-welcome',
    '--skip-release-notes',
    `--user-data-dir=${paths.userData}`,
    `--extensions-dir=${paths.extensions}`,
    `--extensionDevelopmentPath=${packageRoot}`,
    `--extensionTestsPath=${suitePath}`,
  ];
  if (scenario === 'trusted') {
    launchArguments.push('--disable-workspace-trust');
  }

  // 每个场景使用独立会话目录，避免发现开发机上正在运行的 Vite session。
  const childEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    WSI_E2E_SCENARIO: scenario,
    WSI_E2E_WORKSPACE: paths.workspace,
    LOCALAPPDATA: path.join(paths.root, 'local-app-data'),
    XDG_RUNTIME_DIR: path.join(paths.root, 'xdg-runtime'),
    XDG_CACHE_HOME: path.join(paths.root, 'xdg-cache'),
    TMP: paths.temporaryDirectory,
    TEMP: paths.temporaryDirectory,
  };

  console.log(`[vscode-extension:e2e] running ${scenario} scenario`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executablePath, launchArguments, {
      env: childEnvironment,
      stdio: 'inherit',
      windowsHide: true,
    });
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      stopProcess(child);
      reject(new Error(`${scenario} Extension Host E2E timed out after ${TEST_TIMEOUT_MS} ms`));
    }, TEST_TIMEOUT_MS);

    child.once('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${scenario} Extension Host E2E exited with ${code ?? signal ?? 'unknown status'}`));
      }
    });
  });
}

async function removeTemporaryRoot(temporaryRoot: string): Promise<void> {
  const resolvedTemporaryRoot = path.resolve(temporaryRoot);
  const resolvedSystemTemporaryDirectory = path.resolve(os.tmpdir());
  const isOwnedTemporaryRoot =
    path.dirname(resolvedTemporaryRoot) === resolvedSystemTemporaryDirectory &&
    path.basename(resolvedTemporaryRoot).startsWith(TEMPORARY_PREFIX);
  if (!isOwnedTemporaryRoot) {
    throw new Error(`Refusing to remove unexpected E2E directory: ${resolvedTemporaryRoot}`);
  }
  await fs.rm(resolvedTemporaryRoot, { recursive: true, force: true });
}

async function main(): Promise<void> {
  const packageRoot = extensionRoot();
  const executablePath = await resolveVSCodeExecutable(packageRoot);
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), TEMPORARY_PREFIX));

  try {
    const trustedPaths = await createScenarioPaths(temporaryRoot, 'trusted');
    const untrustedPaths = await createScenarioPaths(temporaryRoot, 'untrusted');
    await runScenario(executablePath, packageRoot, trustedPaths, 'trusted');
    await runScenario(executablePath, packageRoot, untrustedPaths, 'untrusted');
  } finally {
    await removeTemporaryRoot(temporaryRoot);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

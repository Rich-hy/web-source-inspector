import path from 'node:path';

import * as vscode from 'vscode';

import {
  planDiagnosticsText,
  resolveIntegrationPlan,
  showIntegrationPlanDiff,
  toAnswerArguments,
  type IntegrationPlanResult,
  type ResolvedIntegrationPlan,
} from './integrationPlan';
import {
  ProjectCliResolutionError,
  runProjectCli,
  type ProjectDoctorResult,
  type ProjectCliResult,
  type ProjectMutationResult,
} from './projectCli';

interface ProjectTarget {
  folder: vscode.WorkspaceFolder;
  projectRoot: string;
  projectLabel: string;
  trustedWorkspaceRoots: string[];
}

interface ProjectCandidate {
  root: string;
  label: string;
  description: string;
}

const MAXIMUM_PROJECT_MANIFESTS = 200;

type ViteBrowserAccessSelection = 'default' | 'loopback';

async function chooseViteBrowserAccess(): Promise<ViteBrowserAccessSelection | undefined> {
  const selected = await vscode.window.showQuickPick([
    { label: '默认：允许本机网卡 IP', value: 'default' as const },
    { label: '仅本机回环地址', value: 'loopback' as const },
  ], { placeHolder: '选择 Vite 浏览器访问范围' });
  return selected?.value;
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

function manifestLooksRelevant(value: Record<string, unknown>): boolean {
  const packageNames = ['dependencies', 'devDependencies'].flatMap((key) => {
    const dependencies = value[key];
    return typeof dependencies === 'object' && dependencies !== null && !Array.isArray(dependencies)
      ? Object.keys(dependencies)
      : [];
  });
  const scripts = typeof value.scripts === 'object' && value.scripts !== null
    ? Object.values(value.scripts as Record<string, unknown>).filter((item): item is string => typeof item === 'string')
    : [];
  return packageNames.some((name) => [
    'vue',
    'vite',
    'webpack',
    '@vue/cli-service',
    'web-source-inspector',
  ].includes(name)) || scripts.some((script) => /\b(?:vite|webpack|vue-cli-service)\b/u.test(script));
}

async function readProjectCandidate(
  folder: vscode.WorkspaceFolder,
  manifestUri: vscode.Uri,
): Promise<ProjectCandidate | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(manifestUri);
    if (bytes.byteLength > 256 * 1024) {
      return undefined;
    }
    const value: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)
      || !manifestLooksRelevant(value as Record<string, unknown>)) {
      return undefined;
    }
    const relativeManifest = vscode.workspace.asRelativePath(manifestUri, false).replace(/\\/gu, '/');
    const relativeRoot = relativeManifest === 'package.json'
      ? '.'
      : relativeManifest.slice(0, -'/package.json'.length);
    const name = (value as Record<string, unknown>).name;
    return {
      root: path.dirname(manifestUri.fsPath),
      label: typeof name === 'string' ? name : relativeRoot,
      description: relativeRoot === '.' ? folder.name : `${folder.name}/${relativeRoot}`,
    };
  } catch {
    return undefined;
  }
}

async function findProjectCandidates(
  folder: vscode.WorkspaceFolder,
  maximumManifests = MAXIMUM_PROJECT_MANIFESTS,
): Promise<ProjectCandidate[]> {
  const manifests = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, '**/package.json'),
    new vscode.RelativePattern(folder, '**/{node_modules,.git,dist,build,coverage}/**'),
    maximumManifests,
  );
  return (await Promise.all(
    manifests.map((manifest) => readProjectCandidate(folder, manifest)),
  )).filter((candidate): candidate is ProjectCandidate => candidate !== undefined)
    .sort((left, right) => left.description.localeCompare(right.description));
}

/** 状态栏与项目选择共用同一组有界 manifest 候选，避免 monorepo 识别规则漂移。 */
export async function findProjectCandidateRoots(
  folder: vscode.WorkspaceFolder,
  maximumManifests = MAXIMUM_PROJECT_MANIFESTS,
): Promise<string[]> {
  return (await findProjectCandidates(folder, maximumManifests)).map((candidate) => candidate.root);
}

async function chooseProjectTarget(): Promise<ProjectTarget | undefined> {
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage('Source Inspector：当前 workspace 未受信任，项目修改已禁用。');
    return undefined;
  }
  if (vscode.env.remoteName) {
    void vscode.window.showWarningMessage('Source Inspector：首版不在 Remote workspace 中修改项目配置。');
    return undefined;
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showWarningMessage('Source Inspector：请先打开一个本地 workspace。');
    return undefined;
  }
  const selected = folders.length === 1
    ? folders[0]
    : vscode.window.showWorkspaceFolderPick({ placeHolder: '选择要接入 Source Inspector 的项目根目录' });
  const folder = await selected;
  if (folder && folder.uri.scheme !== 'file') {
    void vscode.window.showWarningMessage('Source Inspector：项目管理仅支持本地文件系统 workspace。');
    return undefined;
  }
  if (!folder) {
    return undefined;
  }
  const candidates = await findProjectCandidates(folder);
  let selectedProject = candidates[0];
  if (candidates.length > 1) {
    const picked = await vscode.window.showQuickPick(
        candidates.map((candidate) => ({
          label: candidate.label,
          description: candidate.description,
          candidate,
        })),
        { placeHolder: '选择要接入 Source Inspector 的 Vue 项目' },
      );
    if (!picked) {
      return undefined;
    }
    selectedProject = picked.candidate;
  }
  const project = selectedProject ?? {
    root: folder.uri.fsPath,
    label: folder.name,
    description: folder.name,
  };
  return {
    folder,
    projectRoot: project.root,
    projectLabel: project.description,
    trustedWorkspaceRoots: (vscode.workspace.workspaceFolders ?? [])
      .filter((item) => item.uri.scheme === 'file')
      .map((item) => item.uri.fsPath),
  };
}

async function installCommand(target: ProjectTarget): Promise<string> {
  const projectUri = vscode.Uri.file(target.projectRoot);
  if (await fileExists(vscode.Uri.joinPath(projectUri, 'pnpm-lock.yaml'))
    || await fileExists(vscode.Uri.joinPath(target.folder.uri, 'pnpm-lock.yaml'))) {
    const workspaceFlag = target.projectRoot === target.folder.uri.fsPath
      && await fileExists(vscode.Uri.joinPath(target.folder.uri, 'pnpm-workspace.yaml'))
      ? ' -w'
      : '';
    return `pnpm --dir "${target.projectRoot}" add -D${workspaceFlag} web-source-inspector`;
  }
  if (await fileExists(vscode.Uri.joinPath(projectUri, 'yarn.lock'))
    || await fileExists(vscode.Uri.joinPath(target.folder.uri, 'yarn.lock'))) {
    return `yarn --cwd "${target.projectRoot}" add -D web-source-inspector`;
  }
  return `npm --prefix "${target.projectRoot}" install -D web-source-inspector`;
}

async function reportProjectError(target: ProjectTarget, error: unknown): Promise<void> {
  if (error instanceof ProjectCliResolutionError) {
    if (error.code === 'PACKAGE_NOT_INSTALLED') {
      void vscode.window.showWarningMessage(
        `Source Inspector：项目尚未安装 npm 包。请先执行 ${await installCommand(target)}。`,
      );
      return;
    }
    void vscode.window.showErrorMessage(`Source Inspector：项目 CLI 不可用（${error.code}）。`);
    return;
  }
  const code = error instanceof Error && /^[A-Z0-9_:-]{1,80}$/u.test(error.message)
    ? error.message
    : 'INTERNAL_ERROR';
  void vscode.window.showErrorMessage(`Source Inspector：项目操作失败（${code}）。`);
}

function showBlockingPlan(plan: IntegrationPlanResult, errorCode: string | null): void {
  const diagnostics = planDiagnosticsText(plan);
  const suffix = diagnostics ? `\n${diagnostics}` : '';
  void vscode.window.showWarningMessage(
    `Source Inspector：当前项目不能自动接入（${errorCode ?? 'PLAN_BLOCKED'}）。${suffix}`,
    { modal: true },
  );
}

async function loadPlan(
  target: ProjectTarget,
  operation: 'init' | 'remove',
): Promise<ResolvedIntegrationPlan | undefined> {
  let resolved = await resolveIntegrationPlan(
    target.projectRoot,
    operation,
    {},
    target.trustedWorkspaceRoots,
  );
  if (!resolved) {
    return undefined;
  }
  if (operation === 'init'
    && resolved.envelopeOk
    && !resolved.plan.blocked
    && resolved.plan.profile?.bundler === 'vite') {
    const browserAccess = await chooseViteBrowserAccess();
    if (!browserAccess) {
      return undefined;
    }
    if (browserAccess !== 'default') {
      const browserAccessPlan = await resolveIntegrationPlan(
        target.projectRoot,
        operation,
        { ...resolved.answers, browserAccess },
        target.trustedWorkspaceRoots,
      );
      if (!browserAccessPlan) {
        return undefined;
      }
      resolved = browserAccessPlan;
    }
  }
  await showIntegrationPlanDiff(target.folder, resolved.plan, target.projectLabel);
  return resolved;
}

async function showFreshPlanAfterStale(
  target: ProjectTarget,
  operation: 'init' | 'remove',
): Promise<void> {
  void vscode.window.showWarningMessage('Source Inspector：项目文件已变化，原计划已失效，正在重新打开计划。');
  const refreshed = await loadPlan(target, operation);
  if (refreshed?.plan.blocked) {
    showBlockingPlan(refreshed.plan, refreshed.errorCode);
  }
}

function mutationSucceeded(
  result: ProjectCliResult<ProjectMutationResult>,
  operation: ProjectMutationResult['operation'],
): boolean {
  return result.envelope.ok
    && result.envelope.result !== null
    && result.envelope.result.ok
    && result.envelope.result.operation === operation;
}

export async function viewIntegrationPlan(): Promise<void> {
  const target = await chooseProjectTarget();
  if (!target) {
    return;
  }
  try {
    const resolved = await loadPlan(target, 'init');
    if (!resolved) {
      return;
    }
    if (resolved.plan.blocked || !resolved.envelopeOk) {
      showBlockingPlan(resolved.plan, resolved.errorCode);
    } else if (resolved.plan.noOp) {
      void vscode.window.showInformationMessage('Source Inspector：项目已经启用，无需修改。');
    } else {
      void vscode.window.showInformationMessage(`Source Inspector：计划修改 ${resolved.plan.edits.length} 个文件。`);
    }
  } catch (error) {
    await reportProjectError(target, error);
  }
}

export async function enableProject(): Promise<void> {
  const target = await chooseProjectTarget();
  if (!target) {
    return;
  }
  try {
    const resolved = await loadPlan(target, 'init');
    if (!resolved) {
      return;
    }
    if (resolved.plan.blocked || !resolved.envelopeOk) {
      showBlockingPlan(resolved.plan, resolved.errorCode);
      return;
    }
    if (resolved.plan.noOp) {
      void vscode.window.showInformationMessage('Source Inspector：项目已经启用。');
      return;
    }
    const confirmed = await vscode.window.showWarningMessage(
      `将按已展示的计划修改 ${resolved.plan.edits.length} 个文件。`,
      { modal: true },
      '启用',
    );
    if (confirmed !== '启用') {
      return;
    }
    const applied = await runProjectCli<ProjectMutationResult>(target.projectRoot, [
      'init',
      '--json',
      '--phase',
      'apply',
      '--plan-digest',
      resolved.plan.planDigest,
      ...toAnswerArguments(resolved.answers),
    ], target.trustedWorkspaceRoots);
    if (applied.envelope.errorCode === 'PLAN_STALE') {
      await showFreshPlanAfterStale(target, 'init');
      return;
    }
    if (!mutationSucceeded(applied, 'init-apply')) {
      void vscode.window.showErrorMessage(
        `Source Inspector：启用失败（${applied.envelope.errorCode ?? 'INTERNAL_ERROR'}）。`,
      );
      return;
    }
    void vscode.window.showInformationMessage('Source Inspector：项目已启用，请继续运行原有 dev 命令。');
  } catch (error) {
    await reportProjectError(target, error);
  }
}

export async function runProjectDoctor(): Promise<void> {
  const target = await chooseProjectTarget();
  if (!target) {
    return;
  }
  try {
    const result = await runProjectCli<ProjectDoctorResult>(
      target.projectRoot,
      ['doctor', '--json'],
      target.trustedWorkspaceRoots,
    );
    const doctorResult = result.envelope.result;
    const diagnostics = (doctorResult?.diagnostics ?? result.envelope.diagnostics)
      .map((item) => `[${item.code}] ${item.message}`).join('\n');
    if (!doctorResult) {
      void vscode.window.showWarningMessage(
        `Source Inspector：诊断失败（${result.envelope.errorCode ?? 'INTERNAL_ERROR'}）。\n${diagnostics}`,
        { modal: true },
      );
      return;
    }
    if (doctorResult.ok) {
      void vscode.window.showInformationMessage(
        diagnostics ? `Source Inspector：诊断完成。\n${diagnostics}` : 'Source Inspector：诊断完成，未发现阻断问题。',
        { modal: true },
      );
    } else {
      void vscode.window.showWarningMessage(
        `Source Inspector：诊断发现问题（${result.envelope.errorCode ?? 'INTERNAL_ERROR'}）。\n${diagnostics}`,
        { modal: true },
      );
    }
  } catch (error) {
    await reportProjectError(target, error);
  }
}

export async function disableProject(): Promise<void> {
  const target = await chooseProjectTarget();
  if (!target) {
    return;
  }
  try {
    const resolved = await loadPlan(target, 'remove');
    if (!resolved) {
      return;
    }
    if (resolved.plan.blocked || !resolved.envelopeOk) {
      showBlockingPlan(resolved.plan, resolved.errorCode);
      return;
    }
    if (resolved.plan.noOp) {
      void vscode.window.showInformationMessage('Source Inspector：项目当前未启用。');
      return;
    }
    const confirmed = await vscode.window.showWarningMessage(
      `将只撤销 Source Inspector 创建且 fingerprint 未变化的节点，共涉及 ${resolved.plan.edits.length} 个文件。`,
      { modal: true },
      '禁用',
    );
    if (confirmed !== '禁用') {
      return;
    }
    const applied = await runProjectCli<ProjectMutationResult>(target.projectRoot, [
      'remove',
      '--json',
      '--phase',
      'apply',
      '--plan-digest',
      resolved.plan.planDigest,
    ], target.trustedWorkspaceRoots);
    if (applied.envelope.errorCode === 'PLAN_STALE') {
      await showFreshPlanAfterStale(target, 'remove');
      return;
    }
    if (!mutationSucceeded(applied, 'remove-apply')) {
      void vscode.window.showErrorMessage(
        `Source Inspector：禁用失败（${applied.envelope.errorCode ?? 'INTERNAL_ERROR'}）。`,
      );
      return;
    }
    void vscode.window.showInformationMessage('Source Inspector：项目接入已禁用。');
  } catch (error) {
    await reportProjectError(target, error);
  }
}

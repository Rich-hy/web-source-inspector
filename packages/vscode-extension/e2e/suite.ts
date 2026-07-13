import assert from 'node:assert/strict';

import * as vscode from 'vscode';

import { createSourceDigest } from '../src/sourceLocation';
import { SourceOpener } from '../src/sourceOpener';
import type { RootMapping, ServerOpenSourcePayload } from '../src/types';

const EXTENSION_ID = 'web-source-inspector.web-source-inspector-vscode';
const EXPECTED_COMMANDS = [
  'sourceInspector.enableProject',
  'sourceInspector.viewIntegrationPlan',
  'sourceInspector.runDoctor',
  'sourceInspector.disableProject',
  'sourceInspector.connectSession',
  'sourceInspector.chooseSession',
  'sourceInspector.toggleBrowserSelectMode',
  'sourceInspector.openLastSelection',
  'sourceInspector.chooseSourceCandidate',
  'sourceInspector.showDiagnostics',
  'sourceInspector.disconnect',
] as const;

async function activateExtension(): Promise<void> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `Extension ${EXTENSION_ID} was not found`);
  await extension.activate();
  assert.equal(extension.isActive, true, 'Extension did not become active');
}

async function assertCommandsRegistered(): Promise<void> {
  const registeredCommands = new Set(await vscode.commands.getCommands(true));
  for (const command of EXPECTED_COMMANDS) {
    assert.equal(registeredCommands.has(command), true, `Command ${command} was not registered`);
  }
}

async function assertNoSessionCommandsDoNotThrow(includeInitialization: boolean): Promise<void> {
  const commands = [
    'sourceInspector.connectSession',
    'sourceInspector.chooseSession',
    'sourceInspector.toggleBrowserSelectMode',
    'sourceInspector.openLastSelection',
    'sourceInspector.chooseSourceCandidate',
    'sourceInspector.showDiagnostics',
    'sourceInspector.disconnect',
  ];
  if (includeInitialization) {
    commands.unshift(
      'sourceInspector.enableProject',
      'sourceInspector.viewIntegrationPlan',
      'sourceInspector.runDoctor',
      'sourceInspector.disableProject',
    );
  }
  for (const command of commands) {
    await vscode.commands.executeCommand(command);
  }
}

async function assertSourceUriAndSelection(): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, 'Trusted E2E workspace was not opened');
  const sourceUri = vscode.Uri.joinPath(workspaceFolder.uri, 'src', 'App.vue');
  const document = await vscode.workspace.openTextDocument(sourceUri);
  const sourceText = document.getText();
  const selectedText = '<button>Save</button>';
  const startOffset = sourceText.indexOf(selectedText);
  assert.notEqual(startOffset, -1, 'Fixture selection text was not found');
  const endOffset = startOffset + selectedText.length;
  const startPosition = document.positionAt(startOffset);
  const endPosition = document.positionAt(endOffset);
  const rootMapping: RootMapping = {
    rootKey: 'fixture',
    sessionRoot: workspaceFolder.uri.fsPath,
    workspaceRoots: [workspaceFolder.uri.fsPath],
  };
  const payload: ServerOpenSourcePayload = {
    openRequestId: 'e2e-open-source',
    pageClientId: 'e2e-page',
    rootKey: rootMapping.rootKey,
    relativePath: 'src/App.vue',
    range: {
      startLine: startPosition.line + 1,
      startColumn: startPosition.character + 1,
      endLine: endPosition.line + 1,
      endColumn: endPosition.character + 1,
      startOffset,
      endOffset,
    },
    sourceDigest: createSourceDigest(sourceText),
    contextBefore: null,
    contextAfter: null,
    accuracy: 'exact',
    candidateKind: 'element',
    tagName: 'button',
    componentName: null,
    page: { origin: 'http://127.0.0.1:41731', pathname: '/', title: 'E2E fixture' },
    candidates: [],
  };
  const sourceOpener = new SourceOpener({
    getRootMappings: () => new Map([[rootMapping.rootKey, rootMapping]]),
    enableContextRelocation: () => true,
    openMode: () => 'preview',
    revealPosition: () => 'centerIfOutside',
  });

  const result = await sourceOpener.open(payload);
  assert.equal(result.success, true, `Source opener failed with ${result.code}`);
  assert.equal(result.code, 'OK');
  const activeEditor = vscode.window.activeTextEditor;
  assert.ok(activeEditor, 'Source opener did not create an active editor');
  assert.equal(activeEditor.document.uri.toString(), sourceUri.toString(), 'Source opener used an unexpected URI');
  assert.equal(activeEditor.document.getText(activeEditor.selection), selectedText, 'Source selection did not match');
  assert.deepEqual(activeEditor.selection.start, startPosition);
  assert.deepEqual(activeEditor.selection.end, endPosition);
}

export async function run(): Promise<void> {
  const scenario = process.env.WSI_E2E_SCENARIO;
  assert.ok(scenario === 'trusted' || scenario === 'untrusted', `Unknown E2E scenario: ${scenario ?? '<missing>'}`);
  assert.equal(vscode.workspace.isTrusted, scenario === 'trusted', `Unexpected workspace trust state for ${scenario}`);

  await activateExtension();
  await assertCommandsRegistered();
  await assertNoSessionCommandsDoNotThrow(scenario === 'untrusted');
  if (scenario === 'trusted') {
    await assertSourceUriAndSelection();
  }
}

import * as vscode from 'vscode';

import { resolveWorkspaceSourceFile, SourcePathError } from './pathSecurity';
import { createSourceDigest, relocateSourceRange } from './sourceLocation';
import type { OpenSourceResult, RootMapping, ServerOpenSourcePayload } from './types';

export interface SourceOpenerOptions {
  getRootMappings: () => ReadonlyMap<string, RootMapping>;
  enableContextRelocation: () => boolean;
  openMode: () => 'permanent' | 'preview';
  revealPosition: () => 'center' | 'centerIfOutside' | 'top';
}

function revealType(setting: ReturnType<SourceOpenerOptions['revealPosition']>): vscode.TextEditorRevealType {
  switch (setting) {
    case 'center':
      return vscode.TextEditorRevealType.InCenter;
    case 'top':
      return vscode.TextEditorRevealType.AtTop;
    case 'centerIfOutside':
    default:
      return vscode.TextEditorRevealType.InCenterIfOutsideViewport;
  }
}

export class SourceOpener {
  public constructor(private readonly options: SourceOpenerOptions) {}

  public async open(payload: ServerOpenSourcePayload): Promise<OpenSourceResult> {
    try {
      const mapping = this.options.getRootMappings().get(payload.rootKey);
      const targetPath = await resolveWorkspaceSourceFile(mapping, payload.relativePath);
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(targetPath));
      const text = document.getText();
      const digestMatches = createSourceDigest(text) === payload.sourceDigest;
      const relocation = relocateSourceRange(
        text,
        payload.range,
        payload.sourceDigest,
        this.options.enableContextRelocation() ? payload.contextBefore ?? undefined : undefined,
        this.options.enableContextRelocation() ? payload.contextAfter ?? undefined : undefined,
      );
      const editor = await vscode.window.showTextDocument(document, {
        preview: this.options.openMode() === 'preview',
        preserveFocus: false,
      });
      const targetRange = new vscode.Range(
        new vscode.Position(relocation.range.start.line, relocation.range.start.character),
        new vscode.Position(relocation.range.end.line, relocation.range.end.character),
      );
      editor.selection = new vscode.Selection(targetRange.start, targetRange.end);
      editor.revealRange(targetRange, revealType(this.options.revealPosition()));

      if (relocation.status === 'adjusted') {
        void vscode.window.setStatusBarMessage('Source Inspector：已根据唯一上下文校正位置', 4_000);
        return {
          openRequestId: payload.openRequestId,
          success: true,
          code: 'RANGE_ADJUSTED',
          adjusted: true,
          range: {
            startLine: relocation.range.start.line + 1,
            startColumn: relocation.range.start.character + 1,
            endLine: relocation.range.end.line + 1,
            endColumn: relocation.range.end.character + 1,
            startOffset: relocation.range.startOffset,
            endOffset: relocation.range.endOffset,
          },
          accuracy: payload.accuracy,
        };
      }
      if (!digestMatches) {
        void vscode.window.setStatusBarMessage('Source Inspector：页面与编辑器内容不一致，已打开原位置', 5_000);
        return {
          openRequestId: payload.openRequestId,
          success: true,
          code: 'RANGE_STALE',
          range: payload.range,
          accuracy: payload.accuracy,
        };
      }
      if (payload.accuracy === 'approximate') {
        void vscode.window.setStatusBarMessage('Source Inspector：已打开近似源码候选', 4_000);
      }
      return {
        openRequestId: payload.openRequestId,
        success: true,
        code: 'OK',
        range: payload.range,
        accuracy: payload.accuracy,
      };
    } catch (error) {
      if (error instanceof SourcePathError) {
        return { openRequestId: payload.openRequestId, success: false, code: error.code };
      }
      return { openRequestId: payload.openRequestId, success: false, code: 'INTERNAL_ERROR' };
    }
  }
}

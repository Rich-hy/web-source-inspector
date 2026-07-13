import * as vscode from 'vscode';

import { ExtensionController } from './controller';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const controller = new ExtensionController(context);
  context.subscriptions.push(controller);
  await controller.activate();
}

export function deactivate(): void {
  // ExtensionContext 会统一释放控制器和 Bridge 连接。
}

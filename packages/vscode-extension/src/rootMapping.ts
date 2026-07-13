import { promises as fs } from 'node:fs';

import { isCanonicalPathContained } from './pathSecurity';
import type { RootMapping, SessionRootDescriptor } from './types';

export interface CanonicalPathAccess {
  realpath(targetPath: string): Promise<string>;
}

const nodePathAccess: CanonicalPathAccess = {
  realpath: (targetPath) => fs.realpath(targetPath),
};

export function canonicalPathsOverlap(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return isCanonicalPathContained(left, right, platform) || isCanonicalPathContained(right, left, platform);
}

/**
 * rootKey 始终解析到 session 声明根；workspace 根仅作为第二层允许范围。
 * 这样打开 monorepo 子目录时不会意外授权同仓库的其它目录。
 */
export async function createRootMappings(
  sessionRoots: readonly SessionRootDescriptor[],
  workspaceRoots: readonly string[],
  pathAccess: CanonicalPathAccess = nodePathAccess,
  platform: NodeJS.Platform = process.platform,
): Promise<Map<string, RootMapping>> {
  const canonicalWorkspaceRoots = (
    await Promise.all(
      workspaceRoots.map(async (workspaceRoot) => {
        try {
          return await pathAccess.realpath(workspaceRoot);
        } catch {
          return undefined;
        }
      }),
    )
  ).filter((workspaceRoot): workspaceRoot is string => workspaceRoot !== undefined);

  const mappings = new Map<string, RootMapping>();
  for (const sessionRoot of sessionRoots) {
    let canonicalSessionRoot: string;
    try {
      canonicalSessionRoot = await pathAccess.realpath(sessionRoot.canonicalPath);
    } catch {
      continue;
    }
    const overlappingWorkspaceRoots = canonicalWorkspaceRoots.filter((workspaceRoot) =>
      canonicalPathsOverlap(canonicalSessionRoot, workspaceRoot, platform),
    );
    if (overlappingWorkspaceRoots.length > 0) {
      mappings.set(sessionRoot.rootKey, {
        rootKey: sessionRoot.rootKey,
        sessionRoot: canonicalSessionRoot,
        workspaceRoots: overlappingWorkspaceRoots,
      });
    }
  }
  return mappings;
}

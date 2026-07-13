import { describe, expect, it } from 'vitest';

import {
  isCanonicalPathContained,
  resolveWorkspaceSourceFile,
  selectLongestContainingRoot,
  SourcePathError,
  validateWireRelativePath,
  type FileSystemAccess,
} from './pathSecurity';
import type { RootMapping } from './types';

describe('validateWireRelativePath', () => {
  it.each([
    '../secret.txt',
    '..\\secret.txt',
    'C:\\Windows\\win.ini',
    'C:relative.txt',
    '/etc/passwd',
    '\\\\server\\share\\file',
    '\\\\?\\C:\\Windows\\win.ini',
    '\\\\.\\device',
    'file:///C:/Windows/win.ini',
    'packages/../secret',
    'packages//src/file.vue',
    'packages/./src/file.vue',
    'src/%2e%2e/secret.txt',
    'src/file.vue\u0000',
    'src/trailing./file.vue',
    'src/trailing /file.vue',
    'src/CON/file.vue',
  ])('rejects unsafe wire path %s', (input) => {
    expect(validateWireRelativePath(input).ok).toBe(false);
  });

  it('accepts a POSIX workspace-relative Unicode path', () => {
    expect(validateWireRelativePath('packages/中文 路径/App.vue')).toEqual({
      ok: true,
      segments: ['packages', '中文 路径', 'App.vue'],
      normalized: 'packages/中文 路径/App.vue',
    });
  });
});
describe('canonical containment', () => {
  it('rejects Windows prefix confusion and accepts a real child', () => {
    expect(isCanonicalPathContained('D:\\project\\three-edit', 'D:\\project\\three-edit-evil\\App.vue', 'win32')).toBe(false);
    expect(isCanonicalPathContained('D:\\project\\three-edit', 'd:\\PROJECT\\THREE-EDIT\\src\\App.vue', 'win32')).toBe(
      true,
    );
  });

  it('selects the longest legal multi-root match', () => {
    expect(
      selectLongestContainingRoot('/repo/packages/app/src/App.vue', ['/repo', '/repo/packages/app', '/other'], 'linux'),
    ).toBe('/repo/packages/app');
  });
});

describe('resolveWorkspaceSourceFile', () => {
  const root = 'D:\\project\\repo';
  const mapping: RootMapping = { rootKey: 'repo', sessionRoot: root, workspaceRoots: [root] };

  function fakeFileSystem(realpaths: Record<string, string>, file = true): FileSystemAccess {
    return {
      async realpath(targetPath) {
        const resolved = realpaths[targetPath.toLocaleLowerCase('en-US')];
        if (!resolved) {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        }
        return resolved;
      },
      async stat() {
        return { isFile: () => file, isDirectory: () => !file };
      },
    };
  }

  it('allows an internal symlink target that remains in the workspace', async () => {
    const lexicalTarget = 'D:\\project\\repo\\src\\App.vue';
    const internalTarget = 'D:\\project\\repo\\packages\\ui\\App.vue';
    const fileSystem = fakeFileSystem({
      [root.toLowerCase()]: root,
      [lexicalTarget.toLowerCase()]: internalTarget,
    });

    await expect(resolveWorkspaceSourceFile(mapping, 'src/App.vue', fileSystem, 'win32')).resolves.toBe(internalTarget);
  });

  it('rejects a symlink or Junction that escapes the workspace', async () => {
    const lexicalTarget = 'D:\\project\\repo\\src\\App.vue';
    const fileSystem = fakeFileSystem({
      [root.toLowerCase()]: root,
      [lexicalTarget.toLowerCase()]: 'D:\\outside\\App.vue',
    });

    try {
      await resolveWorkspaceSourceFile(mapping, 'src/App.vue', fileSystem, 'win32');
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(SourcePathError);
      expect((error as SourcePathError).code).toBe('PATH_REJECTED');
    }
  });

  it('rejects directories', async () => {
    const lexicalTarget = 'D:\\project\\repo\\src';
    const fileSystem = fakeFileSystem(
      {
        [root.toLowerCase()]: root,
        [lexicalTarget.toLowerCase()]: lexicalTarget,
      },
      false,
    );
    await expect(resolveWorkspaceSourceFile(mapping, 'src', fileSystem, 'win32')).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND',
    });
  });
});

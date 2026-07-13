import { describe, expect, it } from 'vitest';

import { createRootMappings } from './rootMapping';

describe('createRootMappings', () => {
  it('maps a monorepo root only to overlapping open workspace folders', async () => {
    const realpath = async (targetPath: string): Promise<string> => targetPath;
    const mappings = await createRootMappings(
      [{ rootKey: 'repo', canonicalPath: 'D:\\repo', displayName: 'repo' }],
      ['D:\\repo\\packages\\app', 'D:\\unrelated'],
      { realpath },
      'win32',
    );

    expect(mappings.get('repo')).toEqual({
      rootKey: 'repo',
      sessionRoot: 'D:\\repo',
      workspaceRoots: ['D:\\repo\\packages\\app'],
    });
  });

  it('does not map a prefix-confused workspace', async () => {
    const mappings = await createRootMappings(
      [{ rootKey: 'repo', canonicalPath: 'D:\\repo', displayName: 'repo' }],
      ['D:\\repo-evil'],
      { realpath: async (targetPath) => targetPath },
      'win32',
    );
    expect(mappings.size).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';

import {
  SourceManifest,
  ManifestBuildSupersededError,
  SourceIdCollisionError,
  createLocalSnippetDigest,
  createRootKey,
  createSourceDigest,
  createSourceIdGenerator,
  normalizeRootIdentity,
  relativePathFromRoot,
  type SourceRecord,
} from './index.js';

const SOURCE = '<template><main /></template>';
const SESSION_KEY = '0123456789abcdef0123456789abcdef';

function createRecord(
  sourceId: string,
  moduleId: string,
  generation: number,
  overrides: Partial<SourceRecord> = {},
): SourceRecord {
  return {
    sourceId,
    rootKey: 'root_fixture',
    relativePath: `src/${moduleId.split('/').at(-1) ?? 'App.vue'}`,
    framework: 'vue',
    kind: 'element',
    tagName: 'main',
    range: {
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 7,
      startOffset: 0,
      endOffset: 6,
    },
    componentName: 'App',
    controlFlow: null,
    parentSourceId: null,
    sourceDigest: createSourceDigest(SOURCE),
    contextBefore: null,
    contextAfter: null,
    moduleId,
    generation,
    accuracy: 'exact',
    ...overrides,
  };
}

describe('source identity', () => {
  it('is stable within one generation and changes when generation changes', () => {
    const createSourceId = createSourceIdGenerator(SESSION_KEY);
    const baseInput = {
      normalizedRelativePath: 'src/App.vue',
      moduleGeneration: 1,
      nodeKind: 'element' as const,
      tagName: 'main',
      range: {
        startLine: 1,
        startColumn: 11,
        endLine: 1,
        endColumn: 21,
        startOffset: 10,
        endOffset: 20,
      },
      localSnippetDigest: createLocalSnippetDigest(SOURCE, 0, SOURCE.length),
    };

    expect(createSourceId(baseInput)).toBe(createSourceId(baseInput));
    expect(createSourceId(baseInput)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createSourceId(baseInput)).not.toBe(
      createSourceId({ ...baseInput, moduleGeneration: 2 }),
    );
    expect(createSourceId(baseInput)).not.toBe(
      createSourceId({
        ...baseInput,
        range: {
          ...baseInput.range,
          startColumn: 12,
          endColumn: 22,
        },
      }),
    );
    expect(createSourceIdGenerator('fedcba9876543210fedcba9876543210')(baseInput)).not.toBe(
      createSourceId(baseInput),
    );
    expect(() => createSourceIdGenerator('too-short')).toThrow('256 bit');
  });

  it('normalizes Windows roots without lowercasing case-sensitive POSIX roots', () => {
    const secret = SESSION_KEY;

    expect(normalizeRootIdentity('D:\\Workspace\\Project\\')).toBe(
      'd:/workspace/project',
    );
    expect(normalizeRootIdentity('d:/workspace/project')).toBe(
      'd:/workspace/project',
    );
    expect(normalizeRootIdentity('/Workspace/Project')).toBe(
      '/Workspace/Project',
    );
    expect(createRootKey('D:\\Workspace\\Project', secret)).toBe(
      createRootKey('d:/workspace/project/', secret),
    );
    expect(createRootKey('/Workspace/Project', secret)).not.toBe(
      createRootKey('/workspace/project', secret),
    );
    expect(
      relativePathFromRoot('/Workspace/Project', '/Workspace/Project/src/App.vue'),
    ).toBe('src/App.vue');
  });
});

describe('SourceManifest', () => {
  it('marks replaced HMR records stale until the tombstone expires', () => {
    let now = 1_000;
    const manifest = new SourceManifest({ tombstoneTtlMs: 100, now: () => now });
    const moduleId = 'D:/workspace/src/App.vue';
    const createSourceId = createSourceIdGenerator(SESSION_KEY);
    const digestForGeneration = (generation: number) =>
      createSourceDigest(`generation-${generation}`);
    const createId = (generation: number) =>
      createSourceId({
        normalizedRelativePath: 'src/App.vue',
        moduleGeneration: generation,
        nodeKind: 'element',
        tagName: 'main',
        range: {
          startLine: 1,
          startColumn: generation + 1,
          endLine: 1,
          endColumn: generation + 7,
          startOffset: generation,
          endOffset: generation + 6,
        },
        localSnippetDigest: digestForGeneration(generation),
      });
    const firstGeneration = manifest.nextGeneration(moduleId);
    const firstId = createId(firstGeneration);
    manifest.replaceModule(
      moduleId,
      firstGeneration,
      [
        createRecord(firstId, moduleId, firstGeneration, {
          sourceDigest: digestForGeneration(firstGeneration),
        }),
      ],
    );
    const secondGeneration = manifest.nextGeneration(moduleId);
    const secondId = createId(secondGeneration);
    manifest.replaceModule(
      moduleId,
      secondGeneration,
      [
        createRecord(secondId, moduleId, secondGeneration, {
          sourceDigest: digestForGeneration(secondGeneration),
        }),
      ],
    );

    expect(manifest.resolve(firstId)).toMatchObject({
      status: 'stale',
      tombstone: { generation: firstGeneration, staleAt: 1_000 },
    });
    expect(manifest.resolve(secondId)).toMatchObject({ status: 'found' });
    now = 1_099;
    expect(manifest.resolve(firstId)).toMatchObject({ status: 'stale' });
    now = 1_100;
    expect(manifest.resolve(firstId)).toEqual({ status: 'not-found' });
  });

  it('fails closed on collisions without mutating the active manifest', () => {
    const diagnostics: string[] = [];
    const manifest = new SourceManifest({
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
    });
    const sourceId = 'a'.repeat(43);
    const firstModule = 'D:/workspace/src/First.vue';
    const secondModule = 'D:/workspace/src/Second.vue';
    manifest.replaceModule(firstModule, 1, [createRecord(sourceId, firstModule, 1)]);
    expect(() =>
      manifest.replaceModule(secondModule, 1, [
        createRecord(sourceId, secondModule, 1),
      ]),
    ).toThrow(SourceIdCollisionError);
    expect(diagnostics).toEqual(['SOURCE_ID_COLLISION']);
    expect(manifest.resolve(sourceId)).toMatchObject({
      status: 'found',
      record: { moduleId: firstModule },
    });
    expect(manifest.recordsForModule(secondModule)).toEqual([]);
    expect(manifest.size).toBe(1);
  });

  it('keeps the previous module atomically when replacement validation fails', () => {
    const manifest = new SourceManifest();
    const moduleId = 'D:/workspace/src/App.vue';
    const sourceId = 'a'.repeat(43);
    manifest.replaceModule(moduleId, 1, [createRecord(sourceId, moduleId, 1)]);

    expect(() =>
      manifest.replaceModule(moduleId, 2, [
        createRecord('b'.repeat(43), moduleId, 2, {
          range: {
            startLine: 1,
            startColumn: 1,
            endLine: 1,
            endColumn: 2,
            startOffset: 0,
            endOffset: 0,
          },
        }),
      ]),
    ).toThrow('SourceRecord.range');
    expect(manifest.generationForModule(moduleId)).toBe(1);
    expect(manifest.resolve(sourceId)).toMatchObject({ status: 'found' });
  });

  it('allocates a stable generation for each module digest', () => {
    const manifest = new SourceManifest();
    const moduleId = 'D:/workspace/src/App.vue';
    const firstDigest = createSourceDigest('first');
    const secondDigest = createSourceDigest('second');

    expect(manifest.allocateGeneration(moduleId, firstDigest)).toBe(1);
    expect(manifest.allocateGeneration(moduleId, firstDigest)).toBe(1);
    expect(manifest.allocateGeneration(moduleId, secondDigest)).toBe(2);
    expect(manifest.generationForDigest(moduleId, secondDigest)).toBe(2);
  });

  it('commits build staging atomically and discards failed builds', () => {
    const manifest = new SourceManifest();
    const moduleId = 'D:/workspace/src/App.vue';
    const firstId = 'a'.repeat(43);
    const secondId = 'b'.repeat(43);
    manifest.replaceModule(moduleId, 1, [createRecord(firstId, moduleId, 1)]);

    const secondDigest = createSourceDigest('second generation');
    const secondRecord = createRecord(secondId, moduleId, 2, {
      sourceDigest: secondDigest,
    });
    const failedBuild = manifest.beginBuild({
      compilerId: 'webpack-fixture',
      compilationId: 'compilation-1',
      buildId: 1,
    });
    failedBuild.stageModule({
      moduleId,
      generation: 2,
      fullDigest: secondDigest,
      records: [secondRecord],
    });
    failedBuild.discard();

    expect(manifest.resolve(firstId)).toMatchObject({ status: 'found' });
    expect(manifest.resolve(secondId)).toEqual({ status: 'not-found' });

    const successfulBuild = manifest.beginBuild({
      compilerId: 'webpack-fixture',
      compilationId: 'compilation-2',
      buildId: 2,
    });
    successfulBuild.stageModule({
      moduleId,
      generation: 2,
      fullDigest: secondDigest,
      records: [secondRecord, secondRecord],
    });
    expect(successfulBuild.commit()).toMatchObject({
      changedModules: [moduleId],
      recordCount: 1,
    });
    expect(manifest.resolve(firstId)).toMatchObject({ status: 'stale' });
    expect(manifest.resolve(secondId)).toMatchObject({ status: 'found' });
  });

  it('rejects a staging build after a newer build supersedes it', () => {
    const manifest = new SourceManifest();
    const older = manifest.beginBuild({
      compilerId: 'vite-fixture',
      compilationId: 'update-1',
      buildId: 1,
    });
    const newer = manifest.beginBuild({
      compilerId: 'vite-fixture',
      compilationId: 'update-2',
      buildId: 2,
    });

    expect(older.state).toBe('superseded');
    expect(() => older.commit()).toThrow(ManifestBuildSupersededError);
    newer.discard();
  });
});

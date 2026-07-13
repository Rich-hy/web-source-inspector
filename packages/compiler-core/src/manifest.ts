import {
  PROTOCOL_LIMITS,
  isSourceId,
  validateSourceRange
} from '@web-source-inspector/protocol';
import { getCandidatePreference, resolveSourceCandidates } from './candidates';
import { createSourceDigest, isSourceDigest } from './digest';
import { ModuleGenerationAllocator } from './generation';
import { normalizeWireRelativePath } from './path';
import type {
  CandidatePreference,
  CandidateSelectionInput,
  ManifestCandidateResolveResult,
  ManifestBuildIdentity,
  ManifestCommitResult,
  ManifestDiagnostic,
  ManifestModuleStageInput,
  ManifestReplaceResult,
  ManifestResolveResult,
  ManifestTombstone,
  SourceManifestOptions,
  SourceManifestStage,
  SourceRecord
} from './types';

export const DEFAULT_TOMBSTONE_TTL_MS = 2 * 60 * 1000;
export const DEFAULT_TOMBSTONE_CAPACITY = 10_000;
export const DEFAULT_MANIFEST_RECORD_CAPACITY = 100_000;

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const SOURCE_FRAMEWORKS = new Set(['vue', 'react', 'html', 'three']);
const SOURCE_NODE_KINDS = new Set([
  'element',
  'component',
  'fragment',
  'slot',
  'dynamic',
  'three-object'
]);
const CONTROL_FLOW_KINDS = new Set(['for', 'if', 'else-if', 'else']);
const FULL_SOURCE_ID_LENGTH = 43;

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} 必须是正安全整数`);
  }
}

function assertModuleId(moduleId: string): void {
  if (
    typeof moduleId !== 'string' ||
    moduleId.length === 0 ||
    moduleId.length > PROTOCOL_LIMITS.canonicalPathLength ||
    CONTROL_CHARACTER_PATTERN.test(moduleId)
  ) {
    throw new TypeError('moduleId 格式无效');
  }
}

function assertNullableText(
  value: string | null,
  name: string,
  maximumLength: number
): void {
  if (
    value !== null &&
    (typeof value !== 'string' ||
      value.length > maximumLength ||
      value.includes('\u0000'))
  ) {
    throw new TypeError(`${name} 格式无效`);
  }
}

function assertSourceRecord(
  record: SourceRecord,
  moduleId: string,
  generation: number
): void {
  if (
    typeof record !== 'object' ||
    record === null ||
    typeof record.sourceId !== 'string' ||
    record.sourceId.length !== FULL_SOURCE_ID_LENGTH ||
    !isSourceId(record.sourceId)
  ) {
    throw new TypeError('SourceRecord.sourceId 格式无效');
  }
  if (
    !SAFE_ID_PATTERN.test(record.rootKey) ||
    record.rootKey.length > PROTOCOL_LIMITS.rootKeyLength
  ) {
    throw new TypeError('SourceRecord.rootKey 格式无效');
  }
  normalizeWireRelativePath(record.relativePath);
  if (!SOURCE_FRAMEWORKS.has(record.framework)) {
    throw new TypeError('SourceRecord.framework 格式无效');
  }
  if (!SOURCE_NODE_KINDS.has(record.kind)) {
    throw new TypeError('SourceRecord.kind 格式无效');
  }
  if (record.moduleId !== moduleId || record.generation !== generation) {
    throw new TypeError('SourceRecord 的 moduleId/generation 与原子替换参数不一致');
  }
  if (!validateSourceRange(record.range).ok) {
    throw new TypeError('SourceRecord.range 格式无效');
  }
  if (
    record.controlFlow &&
    (!CONTROL_FLOW_KINDS.has(record.controlFlow.kind) ||
      !validateSourceRange(record.controlFlow.range).ok)
  ) {
    throw new TypeError('SourceRecord.controlFlow 格式无效');
  }
  if (!isSourceDigest(record.sourceDigest)) {
    throw new TypeError('SourceRecord.sourceDigest 必须是完整文件 sha256 摘要');
  }
  if (
    typeof record.tagName !== 'string' ||
    record.tagName.length === 0 ||
    record.tagName.length > PROTOCOL_LIMITS.labelLength ||
    CONTROL_CHARACTER_PATTERN.test(record.tagName)
  ) {
    throw new TypeError('SourceRecord.tagName 格式无效');
  }
  assertNullableText(record.componentName, 'componentName', PROTOCOL_LIMITS.labelLength);
  assertNullableText(record.contextBefore, 'contextBefore', PROTOCOL_LIMITS.contextLength);
  assertNullableText(record.contextAfter, 'contextAfter', PROTOCOL_LIMITS.contextLength);
  if (
    record.parentSourceId !== null &&
    !isSourceId(record.parentSourceId)
  ) {
    throw new TypeError('SourceRecord.parentSourceId 格式无效');
  }
  if (record.accuracy !== 'exact' && record.accuracy !== 'approximate') {
    throw new TypeError('SourceRecord.accuracy 格式无效');
  }
}

function sourceRecordIdentity(record: SourceRecord): string {
  return JSON.stringify([
    record.sourceId,
    record.rootKey,
    record.relativePath,
    record.framework,
    record.kind,
    record.tagName,
    record.range.startLine,
    record.range.startColumn,
    record.range.endLine,
    record.range.endColumn,
    record.range.startOffset,
    record.range.endOffset,
    record.componentName,
    record.controlFlow?.kind ?? null,
    record.controlFlow?.range.startLine ?? null,
    record.controlFlow?.range.startColumn ?? null,
    record.controlFlow?.range.endLine ?? null,
    record.controlFlow?.range.endColumn ?? null,
    record.controlFlow?.range.startOffset ?? null,
    record.controlFlow?.range.endOffset ?? null,
    record.parentSourceId,
    record.sourceDigest,
    record.contextBefore,
    record.contextAfter,
    record.moduleId,
    record.generation,
    record.accuracy
  ]);
}

function recordsAreEqual(left: SourceRecord, right: SourceRecord): boolean {
  return sourceRecordIdentity(left) === sourceRecordIdentity(right);
}

export class SourceIdCollisionError extends Error {
  readonly code = 'SOURCE_ID_COLLISION' as const;
  readonly sourceId: string;
  readonly existingRecord: SourceRecord;
  readonly conflictingRecord: SourceRecord;

  constructor(existingRecord: SourceRecord, conflictingRecord: SourceRecord) {
    super(`sourceId ${conflictingRecord.sourceId} 对应不同 SourceRecord`);
    this.name = 'SourceIdCollisionError';
    this.sourceId = conflictingRecord.sourceId;
    this.existingRecord = existingRecord;
    this.conflictingRecord = conflictingRecord;
  }
}

export class ManifestBuildSupersededError extends Error {
  readonly code = 'BUILD_SUPERSEDED' as const;

  constructor() {
    super('Manifest staging 已被更新 build 取代');
    this.name = 'ManifestBuildSupersededError';
  }
}

type InternalStageState = SourceManifestStage['state'];

interface InternalManifestStage {
  identity: ManifestBuildIdentity;
  state: InternalStageState;
  updates: Map<string, ManifestModuleStageInput>;
  removedModules: Set<string>;
}

class SourceManifestStageHandle implements SourceManifestStage {
  readonly identity: ManifestBuildIdentity;
  readonly #stage: InternalManifestStage;
  readonly #stageModule: (input: ManifestModuleStageInput) => void;
  readonly #removeModule: (moduleId: string) => void;
  readonly #commit: () => ManifestCommitResult;
  readonly #discard: () => void;

  constructor(
    stage: InternalManifestStage,
    callbacks: {
      stageModule: (input: ManifestModuleStageInput) => void;
      removeModule: (moduleId: string) => void;
      commit: () => ManifestCommitResult;
      discard: () => void;
    }
  ) {
    this.#stage = stage;
    this.identity = stage.identity;
    this.#stageModule = callbacks.stageModule;
    this.#removeModule = callbacks.removeModule;
    this.#commit = callbacks.commit;
    this.#discard = callbacks.discard;
  }

  get state(): InternalStageState {
    return this.#stage.state;
  }

  stageModule(input: ManifestModuleStageInput): void {
    this.#stageModule(input);
  }

  removeModule(moduleId: string): void {
    this.#removeModule(moduleId);
  }

  commit(): ManifestCommitResult {
    return this.#commit();
  }

  discard(): void {
    this.#discard();
  }
}

export class SourceManifest {
  readonly #tombstoneTtlMs: number;
  readonly #tombstoneCapacity: number;
  readonly #recordCapacity: number;
  readonly #now: () => number;
  readonly #onDiagnostic: ((diagnostic: ManifestDiagnostic) => void) | undefined;
  readonly #generationAllocator = new ModuleGenerationAllocator();
  #activeRecords = new Map<string, SourceRecord>();
  #moduleSourceIds = new Map<string, Set<string>>();
  #moduleGenerations = new Map<string, number>();
  #tombstones = new Map<string, ManifestTombstone>();
  readonly #latestBuildIds = new Map<string, number>();
  readonly #activeStages = new Map<string, InternalManifestStage>();
  #legacyBuildId = 0;

  constructor(options: SourceManifestOptions = {}) {
    this.#tombstoneTtlMs =
      options.tombstoneTtlMs ?? DEFAULT_TOMBSTONE_TTL_MS;
    this.#tombstoneCapacity =
      options.tombstoneCapacity ?? DEFAULT_TOMBSTONE_CAPACITY;
    this.#recordCapacity =
      options.recordCapacity ?? DEFAULT_MANIFEST_RECORD_CAPACITY;
    assertPositiveInteger(this.#tombstoneTtlMs, 'tombstoneTtlMs');
    assertPositiveInteger(this.#tombstoneCapacity, 'tombstoneCapacity');
    assertPositiveInteger(this.#recordCapacity, 'recordCapacity');
    this.#now = options.now ?? Date.now;
    this.#onDiagnostic = options.onDiagnostic;
  }

  get size(): number {
    return this.#activeRecords.size;
  }

  get tombstoneSize(): number {
    this.sweepExpiredTombstones();
    return this.#tombstones.size;
  }

  nextGeneration(moduleId: string): number {
    assertModuleId(moduleId);
    return this.#generationAllocator.reserveNext(moduleId);
  }

  allocateGeneration(moduleId: string, fullDigest: string): number {
    return this.#generationAllocator.allocate(moduleId, fullDigest);
  }

  generationForDigest(
    moduleId: string,
    fullDigest: string
  ): number | undefined {
    return this.#generationAllocator.generationFor(moduleId, fullDigest);
  }

  generationForModule(moduleId: string): number {
    return this.#moduleGenerations.get(moduleId) ?? 0;
  }

  replaceModule(
    moduleId: string,
    generation: number,
    records: readonly SourceRecord[]
  ): ManifestReplaceResult {
    assertModuleId(moduleId);
    assertPositiveInteger(generation, 'generation');
    const currentGeneration = this.#moduleGenerations.get(moduleId) ?? 0;
    if (generation < currentGeneration) {
      throw new RangeError('不能用较旧 generation 替换 manifest 模块');
    }
    const previousCount = this.#moduleSourceIds.get(moduleId)?.size ?? 0;
    const fullDigest = records[0]?.sourceDigest;
    if (records.some((record) => record.sourceDigest !== fullDigest)) {
      throw new TypeError('同一模块的 SourceRecord 必须使用相同完整源码摘要');
    }
    const stage = this.beginBuild({
      compilerId: 'legacy-adapter',
      compilationId: `legacy-${this.#legacyBuildId + 1}`,
      buildId: this.#legacyBuildId + 1
    });
    this.#legacyBuildId += 1;
    try {
      stage.stageModule({
        moduleId,
        generation,
        fullDigest: fullDigest ?? this.#emptyModuleDigest(moduleId, generation),
        records
      });
      stage.commit();
    } catch (error) {
      stage.discard();
      throw error;
    }
    return {
      moduleId,
      generation,
      records: this.recordsForModule(moduleId),
      replacedCount: previousCount,
      collisionCount: 0
    };
  }

  beginBuild(identity: ManifestBuildIdentity): SourceManifestStage {
    this.#assertBuildIdentity(identity);
    const latestBuildId = this.#latestBuildIds.get(identity.compilerId) ?? 0;
    if (identity.buildId <= latestBuildId) {
      throw new ManifestBuildSupersededError();
    }
    const previousStage = this.#activeStages.get(identity.compilerId);
    if (previousStage?.state === 'active') {
      previousStage.state = 'superseded';
    }

    const stage: InternalManifestStage = {
      identity: Object.freeze({ ...identity }),
      state: 'active',
      updates: new Map(),
      removedModules: new Set()
    };
    this.#latestBuildIds.set(identity.compilerId, identity.buildId);
    this.#activeStages.set(identity.compilerId, stage);
    return new SourceManifestStageHandle(stage, {
      stageModule: (input) => this.#stageModule(stage, input),
      removeModule: (moduleId) => this.#stageModuleRemoval(stage, moduleId),
      commit: () => this.#commitStage(stage),
      discard: () => this.#discardStage(stage)
    });
  }

  #stageModule(
    stage: InternalManifestStage,
    input: ManifestModuleStageInput
  ): void {
    this.#assertStageActive(stage);
    assertModuleId(input.moduleId);
    assertPositiveInteger(input.generation, 'generation');
    if (!isSourceDigest(input.fullDigest)) {
      throw new TypeError('fullDigest 必须是完整 sha256 摘要');
    }
    const committedGeneration = this.#moduleGenerations.get(input.moduleId) ?? 0;
    if (input.generation < committedGeneration) {
      throw new RangeError('不能暂存较旧 generation');
    }
    const uniqueRecords = new Map<string, SourceRecord>();
    for (const sourceRecord of input.records) {
      assertSourceRecord(sourceRecord, input.moduleId, input.generation);
      if (sourceRecord.sourceDigest !== input.fullDigest) {
        throw new TypeError('SourceRecord.sourceDigest 与 staging fullDigest 不一致');
      }
      const record = this.#cloneRecord(sourceRecord);
      const duplicate = uniqueRecords.get(record.sourceId);
      if (duplicate) {
        if (!recordsAreEqual(duplicate, record)) {
          this.#throwCollision(duplicate, record);
        }
        continue;
      }
      const existing = this.#recordForCollisionCheck(
        stage,
        record.sourceId,
        input.moduleId
      );
      if (existing && !recordsAreEqual(existing, record)) {
        this.#throwCollision(existing, record);
      }
      uniqueRecords.set(record.sourceId, record);
    }

    this.#generationAllocator.register(
      input.moduleId,
      input.fullDigest,
      input.generation
    );

    stage.removedModules.delete(input.moduleId);
    stage.updates.set(input.moduleId, {
      moduleId: input.moduleId,
      generation: input.generation,
      fullDigest: input.fullDigest,
      records: [...uniqueRecords.values()]
    });
  }

  #stageModuleRemoval(stage: InternalManifestStage, moduleId: string): void {
    this.#assertStageActive(stage);
    assertModuleId(moduleId);
    stage.updates.delete(moduleId);
    stage.removedModules.add(moduleId);
  }

  #commitStage(stage: InternalManifestStage): ManifestCommitResult {
    this.#assertStageActive(stage);
    const nextActiveRecords = new Map(this.#activeRecords);
    const nextModuleSourceIds = new Map(
      [...this.#moduleSourceIds].map(([moduleId, sourceIds]) => [
        moduleId,
        new Set(sourceIds)
      ])
    );
    const nextModuleGenerations = new Map(this.#moduleGenerations);
    const removedRecords: SourceRecord[] = [];

    const removeCurrentRecords = (moduleId: string): void => {
      const sourceIds = nextModuleSourceIds.get(moduleId);
      if (!sourceIds) {
        return;
      }
      for (const sourceId of sourceIds) {
        const record = nextActiveRecords.get(sourceId);
        if (record) {
          removedRecords.push(record);
        }
        nextActiveRecords.delete(sourceId);
      }
      nextModuleSourceIds.delete(moduleId);
    };

    for (const moduleId of stage.removedModules) {
      removeCurrentRecords(moduleId);
    }
    for (const update of stage.updates.values()) {
      removeCurrentRecords(update.moduleId);
      const sourceIds = new Set<string>();
      for (const record of update.records) {
        const existing = nextActiveRecords.get(record.sourceId);
        if (existing && !recordsAreEqual(existing, record)) {
          this.#throwCollision(existing, record);
        }
        nextActiveRecords.set(record.sourceId, record);
        sourceIds.add(record.sourceId);
      }
      nextModuleSourceIds.set(update.moduleId, sourceIds);
      nextModuleGenerations.set(update.moduleId, update.generation);
    }
    if (nextActiveRecords.size > this.#recordCapacity) {
      throw new RangeError(`manifest 记录数不能超过 ${this.#recordCapacity}`);
    }

    const staleAt = this.#now();
    const nextTombstones = new Map<string, ManifestTombstone>();
    for (const [sourceId, tombstone] of this.#tombstones) {
      if (tombstone.expiresAt > staleAt) {
        nextTombstones.set(sourceId, tombstone);
      }
    }
    for (const record of removedRecords) {
      const finalRecord = nextActiveRecords.get(record.sourceId);
      if (!finalRecord || !recordsAreEqual(record, finalRecord)) {
        nextTombstones.delete(record.sourceId);
        nextTombstones.set(
          record.sourceId,
          this.#createTombstone(record, staleAt)
        );
      }
    }
    for (const sourceId of nextActiveRecords.keys()) {
      nextTombstones.delete(sourceId);
    }
    this.#trimTombstoneMap(nextTombstones);

    this.#activeRecords = nextActiveRecords;
    this.#moduleSourceIds = nextModuleSourceIds;
    this.#moduleGenerations = nextModuleGenerations;
    this.#tombstones = nextTombstones;
    stage.state = 'committed';
    if (this.#activeStages.get(stage.identity.compilerId) === stage) {
      this.#activeStages.delete(stage.identity.compilerId);
    }
    return {
      identity: stage.identity,
      changedModules: [...stage.updates.keys()],
      removedModules: [...stage.removedModules],
      recordCount: nextActiveRecords.size
    };
  }

  #discardStage(stage: InternalManifestStage): void {
    if (stage.state !== 'active') {
      return;
    }
    stage.state = 'discarded';
    if (this.#activeStages.get(stage.identity.compilerId) === stage) {
      this.#activeStages.delete(stage.identity.compilerId);
    }
    stage.updates.clear();
    stage.removedModules.clear();
  }

  removeModule(moduleId: string): number {
    assertModuleId(moduleId);
    const sourceIds = this.#moduleSourceIds.get(moduleId);
    if (!sourceIds) {
      return 0;
    }
    const staleAt = this.#now();
    for (const sourceId of sourceIds) {
      const record = this.#activeRecords.get(sourceId);
      this.#activeRecords.delete(sourceId);
      if (record) {
        this.#addTombstone(record, staleAt);
      }
    }
    this.#moduleSourceIds.delete(moduleId);
    this.#trimTombstones();
    return sourceIds.size;
  }

  resolve(sourceId: string): ManifestResolveResult {
    this.sweepExpiredTombstones();
    const record = this.#activeRecords.get(sourceId);
    if (record) {
      return { status: 'found', record };
    }
    const tombstone = this.#tombstones.get(sourceId);
    return tombstone
      ? { status: 'stale', tombstone }
      : { status: 'not-found' };
  }

  resolveCandidates(
    sourceId: string,
    preferenceOrInput: CandidatePreference | CandidateSelectionInput = 'default'
  ): ManifestCandidateResolveResult {
    const resolved = this.resolve(sourceId);
    if (resolved.status !== 'found') {
      return resolved;
    }
    const preference =
      typeof preferenceOrInput === 'string'
        ? preferenceOrInput
        : getCandidatePreference(preferenceOrInput);
    return {
      status: 'found',
      resolution: resolveSourceCandidates(
        resolved.record,
        (candidateSourceId) => this.#activeRecords.get(candidateSourceId),
        preference
      )
    };
  }

  recordsForModule(moduleId: string): SourceRecord[] {
    const sourceIds = this.#moduleSourceIds.get(moduleId);
    if (!sourceIds) {
      return [];
    }
    return [...sourceIds]
      .map((sourceId) => this.#activeRecords.get(sourceId))
      .filter((record): record is SourceRecord => record !== undefined);
  }

  allRecords(): SourceRecord[] {
    return [...this.#activeRecords.values()];
  }

  sweepExpiredTombstones(now = this.#now()): number {
    let removed = 0;
    for (const [sourceId, tombstone] of this.#tombstones) {
      if (tombstone.expiresAt <= now) {
        this.#tombstones.delete(sourceId);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    for (const stage of this.#activeStages.values()) {
      if (stage.state === 'active') {
        stage.state = 'superseded';
      }
    }
    this.#activeRecords.clear();
    this.#moduleSourceIds.clear();
    this.#moduleGenerations.clear();
    this.#tombstones.clear();
    this.#activeStages.clear();
    this.#latestBuildIds.clear();
    this.#generationAllocator.clear();
    this.#legacyBuildId = 0;
  }

  #addTombstone(record: SourceRecord, staleAt: number): void {
    const tombstone = this.#createTombstone(record, staleAt);
    this.#tombstones.delete(record.sourceId);
    this.#tombstones.set(record.sourceId, tombstone);
  }

  #createTombstone(
    record: SourceRecord,
    staleAt: number
  ): ManifestTombstone {
    return {
      sourceId: record.sourceId,
      moduleId: record.moduleId,
      generation: record.generation,
      staleAt,
      expiresAt: staleAt + this.#tombstoneTtlMs
    };
  }

  #trimTombstones(): void {
    this.sweepExpiredTombstones();
    this.#trimTombstoneMap(this.#tombstones);
  }

  #trimTombstoneMap(tombstones: Map<string, ManifestTombstone>): void {
    while (tombstones.size > this.#tombstoneCapacity) {
      const oldestSourceId = tombstones.keys().next().value as
        | string
        | undefined;
      if (!oldestSourceId) {
        break;
      }
      tombstones.delete(oldestSourceId);
    }
  }

  #assertBuildIdentity(identity: ManifestBuildIdentity): void {
    if (typeof identity !== 'object' || identity === null) {
      throw new TypeError('build identity 必须是对象');
    }
    for (const [name, value] of [
      ['compilerId', identity.compilerId],
      ['compilationId', identity.compilationId]
    ] as const) {
      if (
        typeof value !== 'string' ||
        value.length === 0 ||
        value.length > PROTOCOL_LIMITS.clientIdLength ||
        !SAFE_ID_PATTERN.test(value)
      ) {
        throw new TypeError(`${name} 格式无效`);
      }
    }
    assertPositiveInteger(identity.buildId, 'buildId');
  }

  #assertStageActive(stage: InternalManifestStage): void {
    const activeStage = this.#activeStages.get(stage.identity.compilerId);
    const latestBuildId = this.#latestBuildIds.get(stage.identity.compilerId);
    if (
      stage.state === 'superseded' ||
      activeStage !== stage ||
      latestBuildId !== stage.identity.buildId
    ) {
      stage.state = 'superseded';
      throw new ManifestBuildSupersededError();
    }
    if (stage.state !== 'active') {
      throw new Error(`Manifest staging 已处于 ${stage.state} 状态`);
    }
  }

  #recordForCollisionCheck(
    stage: InternalManifestStage,
    sourceId: string,
    currentModuleId: string
  ): SourceRecord | undefined {
    const activeRecord = this.#activeRecords.get(sourceId);
    if (activeRecord) {
      return activeRecord;
    }
    for (const [moduleId, update] of stage.updates) {
      if (moduleId === currentModuleId) {
        continue;
      }
      const record = update.records.find(
        (candidate) => candidate.sourceId === sourceId
      );
      if (record) {
        return record;
      }
    }
    return undefined;
  }

  #throwCollision(
    existingRecord: SourceRecord,
    conflictingRecord: SourceRecord
  ): never {
    const diagnostic: ManifestDiagnostic = {
      code: 'SOURCE_ID_COLLISION',
      message: '检测到 sourceId 对应不同 SourceRecord，已阻断本次提交',
      moduleId: conflictingRecord.moduleId,
      sourceId: conflictingRecord.sourceId
    };
    try {
      this.#onDiagnostic?.(diagnostic);
    } catch {
      // 诊断回调不得改变 fail-closed 行为。
    }
    throw new SourceIdCollisionError(existingRecord, conflictingRecord);
  }

  #cloneRecord(record: SourceRecord): SourceRecord {
    return {
      ...record,
      range: { ...record.range },
      controlFlow: record.controlFlow
        ? { kind: record.controlFlow.kind, range: { ...record.controlFlow.range } }
        : null
    };
  }

  #emptyModuleDigest(moduleId: string, generation: number): string {
    return createSourceDigest(
      JSON.stringify(['empty-manifest-module', moduleId, generation])
    );
  }
}

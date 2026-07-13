import { PROTOCOL_LIMITS } from '@web-source-inspector/protocol';
import { isSourceDigest } from './digest';

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

function assertModuleIdentity(moduleId: string): void {
  if (
    typeof moduleId !== 'string' ||
    moduleId.length === 0 ||
    moduleId.length > PROTOCOL_LIMITS.canonicalPathLength ||
    CONTROL_CHARACTER_PATTERN.test(moduleId)
  ) {
    throw new TypeError('moduleId 格式无效');
  }
}

function assertFullDigest(fullDigest: string): void {
  if (!isSourceDigest(fullDigest)) {
    throw new TypeError('fullDigest 必须是完整 sha256 摘要');
  }
}

/**
 * 在一个活动 session 内按 (moduleId, fullDigest) 分配稳定 generation。
 * 分配结果不会因 build 失败回收，因此失败构建允许留下编号空洞。
 */
export class ModuleGenerationAllocator {
  readonly #generations = new Map<string, Map<string, number>>();
  readonly #lastGeneration = new Map<string, number>();

  allocate(moduleId: string, fullDigest: string): number {
    assertModuleIdentity(moduleId);
    assertFullDigest(fullDigest);
    const moduleGenerations = this.#generations.get(moduleId);
    const existing = moduleGenerations?.get(fullDigest);
    if (existing !== undefined) {
      return existing;
    }

    const generation = this.#reserveNext(moduleId);
    const generations = moduleGenerations ?? new Map<string, number>();
    generations.set(fullDigest, generation);
    this.#generations.set(moduleId, generations);
    return generation;
  }

  generationFor(moduleId: string, fullDigest: string): number | undefined {
    assertModuleIdentity(moduleId);
    assertFullDigest(fullDigest);
    return this.#generations.get(moduleId)?.get(fullDigest);
  }

  /** 校验并登记由缓存 metadata 恢复的 generation。 */
  register(moduleId: string, fullDigest: string, generation: number): void {
    assertModuleIdentity(moduleId);
    assertFullDigest(fullDigest);
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new RangeError('generation 必须是正安全整数');
    }
    const generations = this.#generations.get(moduleId) ?? new Map<string, number>();
    const existing = generations.get(fullDigest);
    if (existing !== undefined && existing !== generation) {
      throw new RangeError('同一 module digest 不能绑定不同 generation');
    }
    for (const [registeredDigest, registeredGeneration] of generations) {
      if (registeredDigest !== fullDigest && registeredGeneration === generation) {
        throw new RangeError('不同 module digest 不能复用 generation');
      }
    }
    generations.set(fullDigest, generation);
    this.#generations.set(moduleId, generations);
    const lastGeneration = this.#lastGeneration.get(moduleId) ?? 0;
    if (generation > lastGeneration) {
      this.#lastGeneration.set(moduleId, generation);
    }
  }

  /** 仅为旧 Adapter 兼容；新调用应传 fullDigest 使用 allocate。 */
  reserveNext(moduleId: string): number {
    assertModuleIdentity(moduleId);
    return this.#reserveNext(moduleId);
  }

  clear(): void {
    this.#generations.clear();
    this.#lastGeneration.clear();
  }

  #reserveNext(moduleId: string): number {
    const current = this.#lastGeneration.get(moduleId) ?? 0;
    if (current >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError('module generation 已达到安全整数上限');
    }
    const generation = current + 1;
    this.#lastGeneration.set(moduleId, generation);
    return generation;
  }
}

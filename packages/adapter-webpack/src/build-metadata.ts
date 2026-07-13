import { isSourceDigest, type SourceRecord } from '@web-source-inspector/compiler-core';

import {
  WSI_BUILD_METADATA_KEY,
  WSI_BUILD_METADATA_SCHEMA_VERSION,
} from './constants.js';
import type {
  WebpackAdapterSession,
  WebpackModuleLike,
  WsiBuildMetadata,
} from './types.js';

export function writeBuildMetadata(
  webpackModule: WebpackModuleLike | undefined,
  metadata: WsiBuildMetadata,
): void {
  if (!webpackModule) {
    throw new Error('TEMPLATE_PIPELINE_MISMATCH:Loader 无法取得当前 Webpack module');
  }
  const container = webpackModule.buildInfo ?? webpackModule.buildMeta ?? {};
  if (webpackModule.buildInfo === undefined && webpackModule.buildMeta === undefined) {
    webpackModule.buildInfo = container;
  }
  container[WSI_BUILD_METADATA_KEY] = metadata;
}

export function clearBuildMetadata(webpackModule: WebpackModuleLike | undefined): void {
  if (webpackModule?.buildInfo) {
    delete webpackModule.buildInfo[WSI_BUILD_METADATA_KEY];
  }
  if (webpackModule?.buildMeta) {
    delete webpackModule.buildMeta[WSI_BUILD_METADATA_KEY];
  }
}

export function readBuildMetadata(
  webpackModule: WebpackModuleLike,
  session: WebpackAdapterSession,
): WsiBuildMetadata | null {
  const candidate =
    webpackModule.buildInfo?.[WSI_BUILD_METADATA_KEY] ??
    webpackModule.buildMeta?.[WSI_BUILD_METADATA_KEY];
  if (candidate === undefined) {
    return null;
  }
  if (!isRecord(candidate)) {
    throw new Error('TEMPLATE_PIPELINE_MISMATCH:Webpack module 中的 WSI metadata 不是对象');
  }

  const metadata = candidate as unknown as WsiBuildMetadata;
  if (
    metadata.schemaVersion !== WSI_BUILD_METADATA_SCHEMA_VERSION ||
    metadata.sessionEpoch !== session.sessionEpoch ||
    metadata.compilerSessionId !== session.compilerSessionId ||
    metadata.adapterVersion !== session.loaderIdentity.adapterVersion ||
    metadata.compilerVersion !== session.compilerVersion ||
    metadata.vueLoaderMajor !== session.vueLoaderMajor ||
    metadata.loaderPath !== session.loaderIdentity.loaderPath ||
    typeof metadata.moduleId !== 'string' ||
    metadata.moduleId.length === 0 ||
    !isSourceDigest(metadata.fullDigest) ||
    !Number.isSafeInteger(metadata.generation) ||
    metadata.generation < 1 ||
    !Array.isArray(metadata.records)
  ) {
    throw new Error('TEMPLATE_PIPELINE_MISMATCH:缓存恢复的 WSI metadata identity 无效');
  }
  assertMetadataRecords(metadata.records, metadata);
  return metadata;
}

function assertMetadataRecords(
  records: readonly SourceRecord[],
  metadata: WsiBuildMetadata,
): void {
  for (const record of records) {
    if (
      !isRecord(record) ||
      record.moduleId !== metadata.moduleId ||
      record.generation !== metadata.generation ||
      record.sourceDigest !== metadata.fullDigest
    ) {
      throw new Error('TEMPLATE_PIPELINE_MISMATCH:WSI metadata 中的 SourceRecord identity 无效');
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

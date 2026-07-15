export type WebpackAdapterErrorCode =
  | 'MULTI_COMPILER_UNSUPPORTED'
  | 'TEMPLATE_PIPELINE_MISMATCH'
  | 'SOURCE_ID_COLLISION'
  | 'BUILD_SUPERSEDED'
  | 'TOOLCHAIN_UNSUPPORTED'
  | 'WDS_TRANSPORT_UNSUPPORTED'
  | 'RAW_WATCH_HTTPS_UNSUPPORTED'
  | 'INVALID_BROWSER_TRANSPORT_CONFIG';

export class WebpackAdapterError extends Error {
  readonly code: WebpackAdapterErrorCode;

  constructor(code: WebpackAdapterErrorCode, message: string) {
    super(message);
    this.name = 'WebpackAdapterError';
    this.code = code;
  }
}

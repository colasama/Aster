export interface RasterServiceReady {
  locale: string;
  layouts: Record<string, Record<string, readonly unknown[]>>;
  maximumDimension: number;
}

export interface RasterServiceWork {
  index: number;
  requestSha256: string;
  header: unknown;
  requests: unknown[];
  knownPayloads?: string[];
  knownResources?: string[];
}

/** Rust authenticates these opaque descriptors against the exact native request and payloads. */
export interface RasterServiceFrame {
  index: number;
  bindings: Record<string, string | undefined>;
  resources: unknown[];
  pixels: { frame: unknown; pixels: { message: { hash: string }; bytes?: Uint8Array } }[];
  textBounds: unknown;
  previousTextBounds: unknown;
  temporal: unknown[];
}

export interface RasterServiceApi {
  open(): Promise<{ projectPath: string; retainedMediaSnapshot?: string }>;
  ready(value: RasterServiceReady): Promise<void>;
  take(): Promise<RasterServiceWork | null>;
  frame(value: RasterServiceFrame): Promise<void>;
  fail(message: string): Promise<void>;
}

declare global {
  interface Window {
    asterRasterService: RasterServiceApi;
  }
}

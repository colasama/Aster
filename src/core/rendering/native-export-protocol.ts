/** Binary inputs for one immutable Phase A frame. Main and Rust validate admission separately. */
export interface NativeResourcePacket {
  message: {
    type: "put_resource";
    hash: string;
    kind: string;
    descriptor: unknown;
  };
  bytes: ArrayBuffer;
}

export interface NativeFramePacket {
  plan: ArrayBuffer;
  resources: NativeResourcePacket[];
  /** Content identities retained by the immediately preceding accepted frame in this job. */
  retainedResources?: string[];
}

export interface NativeExportDecision {
  accepted: boolean;
  reason: string | null;
}

export type NativeRenderHostRequest = {
  jobId: string;
  leaseId: string;
  outputId: string;
} & (
  | { type: "prepareNative" | "sealNative" }
  | { type: "abandonNative"; reason: string }
  | { type: "admitNative"; frame: number; packet: NativeFramePacket }
  | { type: "renderNativeFrame"; frame: number }
);

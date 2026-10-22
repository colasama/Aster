import type { AntiAliasingMode } from "./anti-aliasing.js";
import type { RenderSnapshotIdentity } from "./render-snapshot.js";

export interface NativePreviewSnapshot extends RenderSnapshotIdentity {
  projectDocument: string;
  compositionId: string;
  width: number;
  height: number;
  time: number;
  antiAliasing: AntiAliasingMode;
  visualization: string;
  selectedLayerId?: string;
  memoryBudgetMb: number;
  runtimeAssets?: Array<{ relativePath: string; url: string }>;
}

export interface NativePreviewDescriptor {
  generation: number;
  width: number;
  height: number;
  source: {
    kind: "project";
    authored_sha256: string;
    runtime_sha256: string;
    scope: string;
    revision: number;
    composition_id: string;
  };
  adapter: Record<string, unknown>;
}

export interface DesktopNativePreview {
  available(): Promise<boolean>;
  open(snapshot: NativePreviewSnapshot): Promise<{ id: string; ready: NativePreviewDescriptor }>;
  replace(id: string, snapshot: NativePreviewSnapshot): Promise<NativePreviewDescriptor>;
  present(
    id: string,
    time: number,
    request: number,
  ): Promise<{ sequence: number; render_and_share_ms: number }>;
  close(id: string): Promise<void>;
}

export interface NativePreviewDelivery<Frame = unknown> {
  channel: "aster-native-preview";
  id: string;
  request: number;
  sequence: number;
  generation: number;
  time: number;
  width: number;
  height: number;
  source: NativePreviewDescriptor["source"];
  frame: Frame;
}

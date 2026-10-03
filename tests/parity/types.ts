import type { AntiAliasingMode } from "../../src/core/rendering/anti-aliasing";
import type { Project } from "../../src/core/types";
import type { PersistedMediaImports } from "../../src/importers/media-import-persistence-codec";

export type ToleranceProfile = "exact" | "gpu" | "decode" | "yuv" | "perceptual";

export interface ParityCase {
  id: string;
  project: string;
  composition: string;
  frames: number[];
  size: { width: number; height: number };
  aa: AntiAliasingMode;
  features: string[];
  tolerance: ToleranceProfile;
  isolated?: boolean;
  sequence?: boolean;
  plugins?: string[];
}

export interface GeneratedCase {
  case: ParityCase;
  project: Project & { mediaImports?: PersistedMediaImports };
}

import { createHash } from "node:crypto";
import {
  createLayerForComposition,
  type StandardLayerKind,
} from "../../../src/core/layers/layer-factory";
import { createBlankProject } from "../../../src/core/project/project";
import type { Project } from "../../../src/core/types";
import type { GeneratedCase, ParityCase } from "../types";

export function fixture(id: string) {
  const project = createBlankProject();
  const composition = project.compositions[0];
  project.name = id;
  composition.name = id;
  composition.width = 320;
  composition.height = 180;
  composition.frameRate = { numerator: 30, denominator: 1 };
  composition.duration = 2;
  composition.workArea = { start: 0, end: 2 };
  composition.background = [0, 0, 0, 0];
  composition.layers = [];
  return {
    project,
    composition,
    layer(kind: StandardLayerKind, name?: string) {
      const layer = createLayerForComposition(kind, composition);
      if (name) layer.name = name;
      return layer;
    },
  };
}

export function caseFor(
  id: string,
  project: Project,
  features: string[],
  options: Partial<Omit<ParityCase, "id" | "project" | "composition" | "features">> = {},
): GeneratedCase {
  const ids = new Map<string, string>();
  const serialized = JSON.stringify({ ...project, updatedAt: "2026-01-01T00:00:00.000Z" }).replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    (original) => {
      let stable = ids.get(original);
      if (!stable) {
        const hash = createHash("sha256").update(`${id}:${ids.size}`).digest("hex");
        stable = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
        ids.set(original, stable);
      }
      return stable;
    },
  );
  const stableProject: Project = JSON.parse(serialized);
  const composition = stableProject.compositions.find(
    (item) => item.id === stableProject.activeCompositionId,
  );
  if (!composition) throw new Error(`Parity fixture ${id} has no active composition`);
  return {
    case: {
      id,
      project: `artifacts/parity/projects/${id}/project.json`,
      composition: composition.id,
      frames: [0, 15, 30, 59],
      size: { width: composition.width, height: composition.height },
      aa: "off",
      tolerance: "gpu",
      ...options,
      features: [...new Set(features)].sort(),
    },
    project: stableProject,
  };
}

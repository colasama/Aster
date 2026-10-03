import golden from "../../examples/projects/minimal-golden.aster.json";
import goldenManifest from "../../examples/projects/minimal-golden.manifest.json";
import type { Project } from "../../src/core/types";
import type { ParityCase } from "./types";

export interface ExampleShot {
  start: number;
  end: number;
  composition: string;
}

export function exampleCases(project: Project, shots: ExampleShot[]): ParityCase[] {
  const composition = project.compositions.find((item) => item.id === project.activeCompositionId);
  if (!composition) throw new Error("Enchanted Love has no active composition");
  const rate = composition.frameRate.numerator / composition.frameRate.denominator;
  const frames = new Set<number>();
  for (const shot of shots) {
    const first = Math.round(shot.start * rate);
    const last = Math.min(
      Math.ceil(composition.duration * rate) - 1,
      Math.round(shot.end * rate) - 1,
    );
    frames.add(first);
    frames.add(Math.floor((first + last) / 2));
    frames.add(last);
  }
  return [
    {
      id: "minimal-golden",
      project: "examples/projects/minimal-golden.aster.json",
      composition: golden.activeCompositionId,
      frames: [...goldenManifest.capture.frameIndices],
      size: { width: goldenManifest.capture.width, height: goldenManifest.capture.height },
      aa: "off",
      features: ["example:minimal-golden", "layer:shape"],
      tolerance: "gpu",
    },
    {
      id: "enchanted-love",
      project: "artifacts/parity/projects/enchanted-love/project.json",
      composition: composition.id,
      frames: [...frames].sort((a, b) => a - b),
      size: { width: composition.width, height: composition.height },
      aa: "off",
      features: ["example:enchanted-love", "feature:expressions", "feature:nested-precompositions"],
      tolerance: "gpu",
    },
  ];
}

export function ownerCases(project?: Project): ParityCase[] {
  const compositionId = "ab7c9863-702d-4546-bc20-35f233017b77";
  // These addresses are pinned from the owner's Intro layer, not from host-specific timing data.
  let opening = { first: 0, last: 713 };
  let size = { width: 1920, height: 1080 };
  if (project) {
    const composition = project.compositions.find((item) => item.id === compositionId);
    const intro = composition?.layers.filter(
      (layer) => layer.kind === "precomposition" && layer.name === "开场 Intro",
    );
    if (!composition || intro?.length !== 1)
      throw new Error("Owner project has no unique Intro layer");
    const rate = composition.frameRate.numerator / composition.frameRate.denominator;
    opening = {
      first: Math.ceil(intro[0].inPoint * rate),
      last: Math.ceil(intro[0].outPoint * rate) - 1,
    };
    if (
      opening.first < 0 ||
      opening.last < opening.first ||
      opening.last + 300 >= composition.duration * rate
    )
      throw new Error("Owner opening/main frame ranges exceed the composition");
    size = { width: composition.width, height: composition.height };
  }
  const common = {
    project: "env:ASTER_PERF_PROJECT",
    composition: compositionId,
    size,
    aa: "off" as const,
    tolerance: "gpu" as const,
  };
  return [
    {
      ...common,
      id: "owner-opening",
      frames: [
        ...new Set([
          opening.first,
          opening.first + 1,
          Math.floor((opening.first + opening.last) / 2),
          opening.last,
        ]),
      ],
      features: ["example:owner-project", "segment:opening"],
    },
    {
      ...common,
      id: "owner-main",
      frames: Array.from({ length: 300 }, (_, index) => opening.last + 1 + index),
      features: ["example:owner-project", "segment:main"],
    },
  ];
}

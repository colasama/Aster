import type { AntiAliasingMode } from "../../core/rendering/anti-aliasing";
import type { Composition, Project } from "../../core/types";
import type { BenchmarkRenderer } from "../diagnostics/gpu-benchmark";
import { PRODUCTION_BEAUTY_SETTINGS } from "../presentation/beauty-frame";
import type { NativePreviewView } from "./preview-view";

/** Synthetic scenarios become authored snapshots so Rust evaluates the same benchmark scene. */
export function createNativePreviewBenchmark(
  view: NativePreviewView,
  antiAliasing: AntiAliasingMode,
  memoryBudgetMb: number,
): BenchmarkRenderer {
  let currentComposition: Composition | undefined;
  let sourceProject: Project | undefined;
  let currentProject: Project | undefined;
  return {
    resize: (width, height) => {
      view.canvas.canvas.width = width;
      view.canvas.canvas.height = height;
    },
    render: (composition, time, snapshot, _playing, project) => {
      if (!project) throw new Error("Native benchmark requires an authored project");
      if (sourceProject !== project || currentComposition !== composition) {
        sourceProject = project;
        currentComposition = composition;
        currentProject = {
          ...project,
          activeCompositionId: composition.id,
          compositions: [
            ...project.compositions.filter((c) => c.id !== composition.id),
            composition,
          ],
        };
      }
      if (!currentProject) throw new Error("Native benchmark snapshot is missing");
      return view.presentUncached(
        {
          project: currentProject,
          composition,
          snapshot,
          time,
          target: { width: view.canvas.canvas.width, height: view.canvas.canvas.height },
          settings: PRODUCTION_BEAUTY_SETTINGS,
          antiAliasing,
        },
        memoryBudgetMb,
      );
    },
    complete: () => view.settled(),
  };
}

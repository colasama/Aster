import { EvaluationCache } from "../../core/animation/evaluation-cache";
import { type FlattenedSceneLayer, flattenSceneLayers } from "../../core/scene/scene-evaluation";
import type { Composition, Project } from "../../core/types";
import { buildSceneGeometry, type GeometryResult } from "../geometry/geometry";
import { evaluateSceneCamera } from "./scene-camera";

export interface CachedSceneEvaluation {
  sceneLayers: FlattenedSceneLayer[];
  geometry: GeometryResult;
  cacheHit: boolean;
}

interface SceneEvaluationValue {
  sceneLayers: FlattenedSceneLayer[];
  geometry: GeometryResult;
}

export class SceneEvaluationCache {
  readonly #cache: EvaluationCache<SceneEvaluationValue>;
  #project?: Project;
  #composition?: Composition;
  #revision = 0;

  constructor(capacity = 16, maxBytes = 32 * 1024 * 1024) {
    this.#cache = new EvaluationCache({
      capacity,
      maxBytes,
      sizeOf: (value: SceneEvaluationValue) =>
        value.geometry.data.byteLength + value.sceneLayers.length * 512,
    });
  }

  evaluate(
    composition: Composition,
    project: Project | undefined,
    time: number,
    width: number,
    height: number,
  ): CachedSceneEvaluation {
    if (this.#project !== project || this.#composition !== composition) {
      this.#revision += 1;
      this.#cache.clear();
      this.#project = project;
      this.#composition = composition;
    }
    const key = {
      nodeId: composition.id,
      revision: this.#revision,
      time,
      width,
      height,
    };
    const cached = this.#cache.get(key);
    if (cached) return { ...cached, cacheHit: true };
    const sceneLayers = flattenSceneLayers(composition, project, time);
    const camera = evaluateSceneCamera(composition, time);
    const value = {
      sceneLayers,
      geometry: buildSceneGeometry(composition, sceneLayers, camera),
    };
    this.#cache.set(key, value);
    return { ...value, cacheHit: false };
  }

  hitRate(): number {
    return this.#cache.statistics().hitRate;
  }

  memoryBytes(): number {
    return this.#cache.statistics().bytes;
  }

  clear(): void {
    this.#cache.clear();
    this.#project = undefined;
    this.#composition = undefined;
  }
}

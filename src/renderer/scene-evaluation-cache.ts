import { EvaluationCache } from "../core/evaluation-cache";
import {
  evaluateWorldTransform,
  type FlattenedSceneLayer,
  flattenSceneLayers,
} from "../core/scene-evaluation";
import type { Composition, Project } from "../core/types";
import { buildSceneGeometry, type GeometryResult } from "./geometry";

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

  constructor(capacity = 8) {
    this.#cache = new EvaluationCache(capacity);
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
      this.#cache.invalidateNode(composition.id);
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
    const cameraLayer = composition.layers.find((layer) => layer.kind === "camera");
    const camera = cameraLayer ? evaluateWorldTransform(cameraLayer, composition, time) : undefined;
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
}

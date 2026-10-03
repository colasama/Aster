import { buildCoreCases } from "./core";
import { buildEffectCases } from "./effects";
import { buildMediaCases } from "./media";
import { buildSceneCases } from "./scenes";

export function buildGeneratedCases() {
  return [
    ...buildCoreCases(),
    ...buildEffectCases(),
    ...buildMediaCases(),
    ...buildSceneCases(),
  ].sort((a, b) => a.case.id.localeCompare(b.case.id, "en"));
}

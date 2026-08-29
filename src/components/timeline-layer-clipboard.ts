import { createId, type Layer } from "../core/types";

export function duplicateTimelineLayers(layers: readonly Layer[]): Layer[] {
  const layerIds = new Map(layers.map((layer) => [layer.id, createId()]));
  return layers.map((source) => {
    const layer = structuredClone(source);
    layer.id = layerIds.get(source.id) ?? createId();
    layer.name = `${source.name} Copy`;
    layer.parentId = source.parentId ? layerIds.get(source.parentId) : undefined;
    const properties = [
      ...layer.transform.position,
      ...layer.transform.rotation,
      ...layer.transform.scale,
      ...layer.transform.anchor,
      layer.transform.opacity,
      ...(layer.timeRemap ? [layer.timeRemap] : []),
    ];
    for (const property of properties) {
      if (property.mode !== "animated") continue;
      property.keyframes = property.keyframes.map((keyframe) => ({ ...keyframe, id: createId() }));
    }
    layer.effects = layer.effects.map((effect) => ({
      ...effect,
      id: createId(),
      parameterKeyframes: effect.parameterKeyframes
        ? Object.fromEntries(
            Object.entries(effect.parameterKeyframes).map(([parameter, keyframes]) => [
              parameter,
              keyframes.map((keyframe) => ({ ...keyframe, id: createId() })),
            ]),
          )
        : undefined,
    }));
    return layer;
  });
}

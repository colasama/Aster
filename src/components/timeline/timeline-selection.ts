import type { Id, Layer } from "../../core/types";

/**
 * Resolves a click on a timeline layer row: Ctrl/Cmd toggles one layer, Shift selects the range
 * from the primary (first) selected layer, and a plain click selects only the clicked layer.
 */
export function timelineClickSelection(
  layers: readonly Pick<Layer, "id">[],
  selection: readonly Id[],
  layerId: Id,
  range: boolean,
  toggle: boolean,
): Id[] {
  const anchorIndex = layers.findIndex((layer) => layer.id === selection[0]);
  const targetIndex = layers.findIndex((layer) => layer.id === layerId);
  if (range && anchorIndex >= 0 && targetIndex >= 0) {
    const [start, end] =
      anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
    const spanned = layers.slice(start, end + 1).map((layer) => layer.id);
    const anchorId = layers[anchorIndex].id;
    const ids = [anchorId, ...spanned.filter((id) => id !== anchorId)];
    return toggle ? [...new Set([...selection, ...ids])] : ids;
  }
  if (toggle || range)
    return selection.includes(layerId)
      ? selection.filter((id) => id !== layerId)
      : [...selection, layerId];
  return [layerId];
}

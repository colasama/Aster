import type { Layer, TextStyle } from "../types";

export function resolveTextStyle(layer: Pick<Layer, "name" | "size" | "textStyle">): TextStyle {
  const hero = layer.name === "ASTER";
  return (
    layer.textStyle ?? {
      fontFamily: 'Inter, "Segoe UI", sans-serif',
      fontSize: layer.size[1] * (hero ? 0.82 : 0.56),
      fontWeight: hero ? 800 : 600,
      alignment: "center",
      tracking: layer.size[1] * (hero ? 0.15 : 0.34),
      leading: layer.size[1] * 0.72,
      strokeWidth: 0,
      strokeColor: [0, 0, 0, 1],
    }
  );
}

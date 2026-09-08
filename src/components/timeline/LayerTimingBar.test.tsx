import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { activeComposition, createBlankProject } from "../../core/project/project";
import { LayerTimingBar } from "./LayerTimingBar";

describe("layer timing bar", () => {
  it("keeps the layer name out of the visible track content", () => {
    const layer = activeComposition(createBlankProject()).layers[0];
    const markup = renderToStaticMarkup(
      <LayerTimingBar layer={layer} onDragStart={vi.fn()} pixelsPerSecond={40} />,
    );

    expect(markup).not.toContain("<span");
    expect(markup).toContain(`title="${layer.name}`);
  });
});

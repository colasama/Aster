import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "../../core/layers/layer-factory";
import { createBlankProject } from "../../core/project/project";
import { staticValue } from "../../core/types";
import {
  collectTimelinePropertyGroups,
  timelinePropertyTrackLabel,
} from "../timeline/timeline-property-tracks";

describe("text animator timeline tracks", () => {
  it("exposes animator and Range Selector properties with units and bounds", () => {
    const project = createBlankProject();
    const layer = createLayerForComposition("text", project.compositions[0]);
    const animator = layer.textAnimator?.groups[0];
    const selector = animator?.selectors[0];
    if (!animator || !selector || selector.kind !== "range")
      throw new Error("Expected range text animator");
    animator.name = "Letters";
    selector.name = "Reveal";
    selector.units = "percentage";
    animator.properties.opacity = staticValue(100);
    animator.properties.fillColor = [
      staticValue(1),
      staticValue(0.5),
      staticValue(0.25),
      staticValue(1),
    ];

    const groups = collectTimelinePropertyGroups(layer);
    const properties = groups.find((group) => group.id.endsWith(":properties"));
    const range = groups.find((group) => group.id.includes(":selector:"));
    expect(properties).toMatchObject({ label: "Letters", source: "transform" });
    expect(range).toMatchObject({ label: "Letters · Reveal", source: "transform" });
    expect(
      properties?.tracks.find((track) => track.id.endsWith(":property:opacity")),
    ).toMatchObject({
      labelKey: "text.property.opacity",
      min: 0,
      max: 100,
      unit: "%",
    });
    const alpha = properties?.tracks.find((track) => track.id.endsWith(":property:fillColor:3"));
    expect(alpha).toMatchObject({ labelKey: "text.property.fillColor", labelSuffix: "A" });
    expect(alpha && timelinePropertyTrackLabel(alpha, (key) => key)).toBe(
      "text.property.fillColor A",
    );
    expect(
      range?.tracks.map((track) => {
        const parts = track.id.split(":");
        return parts[parts.length - 1];
      }),
    ).toEqual(["amount", "start", "end", "offset", "smoothness", "easeHigh", "easeLow"]);
    expect(range?.tracks.find((track) => track.id.endsWith(":start"))).toMatchObject({
      labelKey: "text.selector.start",
      unit: "%",
      min: -1_000_000,
      max: 1_000_000,
    });
  });
});

import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "../layers/layer-factory";
import { createCompositionReference } from "../project/composition-source";
import { createBlankComposition, createBlankProject } from "../project/project";
import { staticValue } from "../types";
import { audioInstanceTime, collectAudioInstances } from "./nested-audio";

describe("nested audio", () => {
  it("maps independent reference clocks, multiplies gains and ignores visual visibility", () => {
    const project = createBlankProject();
    const root = project.compositions[0];
    const child = createBlankComposition("Audio source");
    project.compositions.push(child);
    const audio = createLayerForComposition("audio", child);
    audio.audio = { levelsDb: [-6, -6], pan: 0, muted: false, reversed: false };
    child.layers = [audio];
    const first = createCompositionReference(project, root, child.id, 2);
    first.visible = false;
    first.audio = { levelsDb: [-6, -6], pan: 0, muted: false, reversed: false };
    first.timeOffset = 1;
    first.timeStretch = 2;
    const second = createCompositionReference(project, root, child.id, 0);
    second.timeRemap = staticValue(5);
    root.layers = [first, second];
    const instances = collectAudioInstances(project, root);
    expect(instances).toHaveLength(2);
    expect(instances[0].leftGain).toBeCloseTo(10 ** (-12 / 20));
    expect(audioInstanceTime(instances[0], 4)).toBe(2);
    expect(audioInstanceTime(instances[1], 4)).toBe(5);
    expect(audioInstanceTime(instances[0], 1)).toBeUndefined();
    first.audioEnabled = false;
    expect(collectAudioInstances(project, root)).toHaveLength(1);
  });

  it("returns silence outside a remapped source instead of repeating its first sample", () => {
    const project = createBlankProject();
    const root = project.compositions[0];
    const child = createBlankComposition();
    child.layers = [createLayerForComposition("audio", child)];
    project.compositions.push(child);
    const wrapper = createCompositionReference(project, root, child.id, 0);
    wrapper.timeRemap = staticValue(-1);
    root.layers = [wrapper];
    expect(audioInstanceTime(collectAudioInstances(project, root)[0], 0)).toBeUndefined();
  });
});

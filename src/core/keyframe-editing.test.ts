import { describe, expect, it } from "vitest";
import {
  collectEditableKeyframes,
  copyKeyframes,
  pasteKeyframes,
  removeKeyframes,
  retimeKeyframes,
} from "./keyframe-editing";
import { activeComposition, createDemoProject } from "./project";

describe("keyframe editing", () => {
  it("copies and pastes track-aware keyframes relative to the playhead", () => {
    const composition = activeComposition(createDemoProject());
    const entries = collectEditableKeyframes(composition).slice(0, 2);
    const clipboard = copyKeyframes(entries);
    expect(clipboard).toBeDefined();
    if (!clipboard) throw new Error("Expected copied keyframes");

    const pasted = pasteKeyframes(clipboard, 5, composition.duration);
    expect(pasted.operations).toHaveLength(2);
    expect(pasted.selectedIds).toHaveLength(2);
    expect(new Set(pasted.selectedIds).size).toBe(2);
    expect(pasted.operations[0]).toMatchObject({ type: "addKeyframe" });
    expect("keyframe" in pasted.operations[0] && pasted.operations[0].keyframe.time).toBe(5);
  });

  it("moves a selection as one frame-snapped transaction", () => {
    const composition = activeComposition(createDemoProject());
    const entries = collectEditableKeyframes(composition).slice(0, 2);
    const active = entries[0];
    const operations = retimeKeyframes(entries, active.keyframe.id, 1.019, 1 / 60, false);

    expect(operations).toHaveLength(2);
    expect(operations[0]).toMatchObject({
      keyframeId: active.keyframe.id,
      time: 1.0166666666666666,
    });
    expect(operations[1].time - operations[0].time).toBeCloseTo(
      entries[1].keyframe.time - entries[0].keyframe.time,
    );
    expect(
      retimeKeyframes(entries, active.keyframe.id, 1.019, 1 / 60, false, false)[0],
    ).toMatchObject({ time: 1.019 });
  });

  it("scales selected timing around the earliest keyframe", () => {
    const composition = activeComposition(createDemoProject());
    const entries = collectEditableKeyframes(composition).slice(0, 2);
    const active = entries[1];
    const originalSpan = active.keyframe.time - entries[0].keyframe.time;
    const operations = retimeKeyframes(
      entries,
      active.keyframe.id,
      entries[0].keyframe.time + originalSpan * 2,
      1 / 600,
      true,
    );

    expect(operations[0].time).toBeCloseTo(entries[0].keyframe.time);
    expect(operations[1].time - operations[0].time).toBeCloseTo(originalSpan * 2);
    expect(removeKeyframes(entries)).toHaveLength(2);
  });

  it("preserves group offsets after one snap and clamps move/scale to the composition", () => {
    const composition = activeComposition(createDemoProject());
    const entries = collectEditableKeyframes(composition).slice(0, 2);
    const active = entries[0];
    const moved = retimeKeyframes(entries, active.keyframe.id, 99, 1 / 60, false, false, 10);
    expect(Math.max(...moved.map((operation) => operation.time))).toBe(10);
    expect(moved[1].time - moved[0].time).toBeCloseTo(
      entries[1].keyframe.time - entries[0].keyframe.time,
    );

    const scaled = retimeKeyframes(entries, entries[1].keyframe.id, 99, 1 / 60, true, false, 10);
    expect(Math.max(...scaled.map((operation) => operation.time))).toBe(10);
    expect(Math.min(...scaled.map((operation) => operation.time))).toBeGreaterThanOrEqual(0);
  });
});

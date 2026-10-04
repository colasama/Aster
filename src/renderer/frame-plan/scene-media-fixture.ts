import { encodeFramePlan } from "./codec";
import { mediaResourceFixtures } from "./media-resource-fixture";
import { sceneBufferFixtureInput } from "./scene-buffer-fixture";
import { buildSceneBufferPlan } from "./scene-buffer-plan";
import { bindSceneMediaPlan } from "./scene-media-plan";
import type { SceneMediaBinding } from "./types";

export async function sceneMediaFixtures() {
  const messages = await mediaResourceFixtures();
  return messages
    .filter((message) => message.kind === "media_frame")
    .map((frame, index) => {
      const source = messages.find((message) => message.hash === frame.descriptor.source);
      if (source?.kind !== "media_source") throw new Error("Missing fixture source");
      const input = sceneBufferFixtureInput();
      input.snapshot = { ...input.snapshot, snapshotScope: source.descriptor.authorization_scope };
      const media: SceneMediaBinding[] = [
        { draw_index: 0, binding: { kind: "frame", hash: frame.hash } },
        { draw_index: 1, binding: { kind: "pending" } },
        { draw_index: 2, binding: { kind: "frame", hash: frame.hash } },
      ];
      const plan = bindSceneMediaPlan(buildSceneBufferPlan(input), media);
      return {
        id: `scene-media-${index}`,
        bytes: encodeFramePlan(plan.metadata, plan.blobs),
        media,
        messages: [source, frame],
      };
    });
}

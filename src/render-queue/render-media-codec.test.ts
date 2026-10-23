// @vitest-environment node
import { expect, test } from "vitest";
import { parseRenderMediaManifest } from "./render-media-codec";

test("the queue codec works without a browser and accepts the authored PSD retained-size mode", () => {
  const manifest = {
    version: 1,
    entries: [
      {
        sourceId: "psd",
        contentIdentity: "document:layer",
        sourceKind: "psd",
        kind: "psd",
        documentIdentity: "document",
        importMode: "compositionRetainLayerSizes",
        layerKey: "layer",
        payloadId: "rgba",
        fallback: true,
        decodedWidth: 1,
        decodedHeight: 1,
        crop: [0, 0, 1, 1],
      },
    ],
    payloads: [
      { id: "rgba", kind: "rgba", identity: "fnv64:0000000000000000:4", bytes: "AAAAAA==" },
    ],
  };
  expect(parseRenderMediaManifest(JSON.stringify(manifest))).toEqual(manifest);
  manifest.entries[0].importMode = "compositionRetainSizes";
  expect(() => parseRenderMediaManifest(JSON.stringify(manifest))).toThrow("PSD entry");
});

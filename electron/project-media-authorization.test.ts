import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { authorizeProjectMediaExternalPaths } from "./project-media-authorization";
import { renderPathKey } from "./render-queue-paths";

describe("project media local authorization", () => {
  it("allows only picker-authorized footage, PSD, and sequence paths", () => {
    const video = resolve("fixtures/clip.mp4");
    const psd = resolve("fixtures/document.psd");
    const frame = resolve("fixtures/frame-0001.png");
    const project = document([
      { kind: "video", storage: { kind: "external", externalPath: video } },
      { kind: "psd", storage: { kind: "external", externalPath: psd } },
      {
        kind: "imageSequence",
        frames: [{ storage: { kind: "external", externalPath: frame } }],
      },
    ]);
    expect(() =>
      authorizeProjectMediaExternalPaths(project, {
        allowedAssets: new Map([
          [renderPathKey(video), video],
          [renderPathKey(psd), psd],
          [renderPathKey(frame), frame],
        ]),
      }),
    ).not.toThrow();
  });

  it("rejects ungranted, relative, malformed, and oversized paths", () => {
    const path = resolve("fixtures/document.psd");
    expect(() =>
      authorizeProjectMediaExternalPaths(
        document([{ kind: "psd", storage: { kind: "external", externalPath: path } }]),
        { allowedAssets: new Map() },
      ),
    ).toThrow("not selected");
    expect(() =>
      authorizeProjectMediaExternalPaths(
        document([{ kind: "psd", storage: { kind: "external", externalPath: "relative.psd" } }]),
        { allowedAssets: new Map() },
      ),
    ).toThrow("absolute bounded");
    expect(() =>
      authorizeProjectMediaExternalPaths(
        document([{ kind: "psd", storage: { kind: "external", externalPath: "x".repeat(4097) } }]),
        { allowedAssets: new Map() },
      ),
    ).toThrow("absolute bounded");
    expect(() =>
      authorizeProjectMediaExternalPaths(
        { mediaImports: { payloads: null } },
        {
          allowedAssets: new Map(),
        },
      ),
    ).toThrow("bounded array");
  });

  it("does not grant access through a key collision with a different canonical value", () => {
    const requested = resolve("fixtures/document.psd");
    expect(() =>
      authorizeProjectMediaExternalPaths(
        document([{ kind: "psd", storage: { kind: "external", externalPath: requested } }]),
        { allowedAssets: new Map([[renderPathKey(requested), resolve("fixtures/other.psd")]]) },
      ),
    ).toThrow("not selected");
  });
});

function document(payloads: unknown[]): unknown {
  return { mediaImports: { version: 1, entries: [], payloads } };
}

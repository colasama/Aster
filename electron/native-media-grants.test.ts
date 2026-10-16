// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RenderJobManifest } from "../src/core/rendering/render-queue";
import { mediaBytesIdentity } from "../src/importers/media-import-identity";
import { contentResourceHashSync } from "../src/renderer/frame-plan/resources";
import { NativeMediaGrants } from "./native-media-grants";
import { RenderMediaSnapshotStore } from "./render-media-snapshot-store";
import { renderPathKey } from "./render-queue-paths";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aster-native-grants-"));
  roots.push(root);
  const bytes = Buffer.from("immutable media bytes");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const source = { id: "source-😀", kind: "still", contentIdentity: `sha256:${sha256}` };
  const path = join(root, "source.png");
  await writeFile(path, bytes);
  const store = new RenderMediaSnapshotStore(join(root, "snapshots"));
  const allowedAssets = new Map([[renderPathKey(path), path]]);
  const snapshot = await store.capture(
    "job",
    JSON.stringify({
      version: 1,
      payloads: [],
      entries: [
        {
          sourceId: source.id,
          sourceKind: source.kind,
          contentIdentity: source.contentIdentity,
          kind: "locator",
          locator: { kind: "session", url: `aster-asset://local/${encodeURIComponent(path)}` },
        },
      ],
    }),
    { allowedAssets },
  );
  store.commit("job");
  const lease = await store.authorizeLaunch("job", snapshot, { allowedAssets });
  const manifest = {
    id: "job",
    projectSnapshot: JSON.stringify({ sources: [source] }),
    renderMediaSnapshot: snapshot,
  } as RenderJobManifest;
  return { root, bytes, sha256, source, path, lease, manifest };
}
describe("native media authorization", () => {
  it("uses the immutable lease copy and matches the production content-addressed source", async () => {
    const f = await fixture();
    await writeFile(f.path, "changed original");
    const grants = await NativeMediaGrants.create(
      join(f.root, "native"),
      f.manifest,
      f.lease.nativeMediaPaths ?? [],
    );
    const values = JSON.parse(await readFile(grants.path, "utf8"));
    expect(values).toHaveLength(1);
    expect(values[0].source).toBe(
      contentResourceHashSync({
        kind: "media_source",
        descriptor: {
          source_id: f.source.id,
          content_identity: f.source.contentIdentity,
          authorization_scope: "render-job:job",
          media_kind: "image",
        },
      }),
    );
    expect(values[0].sha256).toBe(f.sha256);
    expect(values[0].path).not.toBe(f.path);
    expect(await readFile(values[0].path)).toEqual(f.bytes);
    await grants.dispose();
    expect(await readdir(join(f.root, "native"))).toEqual([]);
    f.lease.dispose();
    expect(() => f.lease.nativeMediaPaths).toThrow(/disposed/);
  });
  it("rejects an arbitrary renderer locator even when its declared SHA is valid and cleans up", async () => {
    const f = await fixture();
    const snapshot = JSON.parse(f.manifest.renderMediaSnapshot ?? "{}");
    snapshot.entries[0].locator.url = `aster-asset://local/${encodeURIComponent(f.path)}`;
    f.manifest.renderMediaSnapshot = JSON.stringify(snapshot);
    const root = join(f.root, "native");
    await expect(
      NativeMediaGrants.create(root, f.manifest, f.lease.nativeMediaPaths ?? []),
    ).rejects.toThrow(/authorization lease/);
    expect(await readdir(root)).toEqual([]);
    f.lease.dispose();
  });
  it("materializes and authenticates inline legacy identities without granting runtime URLs", async () => {
    const f = await fixture();
    const source = {
      ...f.source,
      id: "inline-\ud800",
      contentIdentity: mediaBytesIdentity(f.bytes),
      dataUrl: `data:image/png;base64,${f.bytes.toString("base64")}`,
      runtimeUrl: "file:///untrusted",
    };
    f.manifest.projectSnapshot = JSON.stringify({ sources: [source] });
    f.manifest.renderMediaSnapshot = undefined;
    const root = join(f.root, "native");
    const grants = await NativeMediaGrants.create(root, f.manifest, []);
    const [grant] = JSON.parse(await readFile(grants.path, "utf8"));
    expect(grant.sha256).toBe(f.sha256);
    expect(await readFile(grant.path)).toEqual(f.bytes);
    expect(grant.source).toBe(
      contentResourceHashSync({
        kind: "media_source",
        descriptor: {
          source_id: {
            utf16_units: Array.from({ length: source.id.length }, (_, i) =>
              source.id.charCodeAt(i),
            ),
          },
          content_identity: source.contentIdentity,
          authorization_scope: "render-job:job",
          media_kind: "image",
        },
      }),
    );
    await grants.dispose();
    source.contentIdentity = `sha256:${"0".repeat(64)}`;
    f.manifest.projectSnapshot = JSON.stringify({ sources: [source] });
    await expect(NativeMediaGrants.create(root, f.manifest, [])).rejects.toThrow(
      /identity mismatch/,
    );
    expect(await readdir(root)).toEqual([]);
    f.lease.dispose();
  });
  it("keeps sequence members independently granted by frame and byte identity", async () => {
    const f = await fixture();
    const original = JSON.parse(f.manifest.renderMediaSnapshot ?? "{}").entries[0];
    const source = { ...f.source, kind: "imageSequence", contentIdentity: "sequence-generation" };
    f.manifest.projectSnapshot = JSON.stringify({ sources: [source] });
    f.manifest.renderMediaSnapshot = JSON.stringify({
      version: 1,
      entries: [
        {
          sourceId: source.id,
          sourceKind: source.kind,
          contentIdentity: source.contentIdentity,
          kind: "imageSequence",
          selection: {
            frames: [2, 9].map((frame) => ({
              frame,
              file: { byteIdentity: f.source.contentIdentity, locator: original.locator },
            })),
          },
        },
      ],
    });
    const grants = await NativeMediaGrants.create(
      join(f.root, "native"),
      f.manifest,
      f.lease.nativeMediaPaths ?? [],
    );
    const values = JSON.parse(await readFile(grants.path, "utf8"));
    expect(values.map((v: { sequence_frame: number }) => v.sequence_frame)).toEqual([2, 9]);
    expect(values[0].source).toBe(values[1].source);
    await grants.dispose();
    f.lease.dispose();
  });
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { digest } from "../parity/provenance.mjs";
import {
  historicalProjectValidator,
  preserveFrozenProjectSource,
} from "./frozen-project-source.mjs";
import { M0Evidence, sha256 } from "./m0-evidence.mjs";

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "aster-frozen-project-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, windowsHide: true, encoding: "utf8" }).trim();
  try {
    git("init", "--quiet");
    git("config", "core.autocrlf", "false");
    const originals = {
      "electron/main.ts": "export const renderer = 'original';\n",
      "src/renderer/webgpu-renderer.ts": "export const pixels = 'frozen';\n",
      "shaders/manifest.json": JSON.stringify({
        version: 1,
        fragments: { scene: "scene.wgsl" },
        programs: { scene: { fragments: ["scene"] } },
      }),
    };
    for (const [path, bytes] of Object.entries(originals)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), bytes);
    }
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "core.autocrlf=false",
      "commit",
      "--quiet",
      "-m",
      "original producer",
    );
    const source = {
      commit: git("rev-parse", "HEAD"),
      files: Object.entries(originals).map(([path, bytes]) => ({
        path,
        sha256: sha256(Buffer.from(bytes)),
      })),
      bridge_sha256: "a".repeat(64),
      ir_cli_sha256: sha256(Buffer.from("historical validator")),
    };
    source.renderer_source_sha256 = digest({
      files: source.files,
      bridge_sha256: source.bridge_sha256,
      ir_cli_sha256: source.ir_cli_sha256,
    });
    await run({ root, output: join(root, "artifacts"), source, originals });
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
}

test("host migration preserves the original producer bytes without changing current sources", () =>
  fixture(async ({ root, output, source, originals }) => {
    await writeFile(join(root, "electron/main.ts"), "export const renderer = 'native';\n");
    const reader = new M0Evidence(root),
      proof = await preserveFrozenProjectSource({ root, output }, source, reader);
    assert.equal(proof.current_ts_files_match, false);
    assert.deepEqual(
      proof.changed_current_files.map((f) => f.path),
      ["electron/main.ts"],
    );
    const host = proof.files.find((f) => f.original_path === "electron/main.ts");
    assert.equal(host.origin, "recorded-git-commit");
    assert.equal(await readFile(join(root, host.path), "utf8"), originals["electron/main.ts"]);
    assert.match(await readFile(join(root, "electron/main.ts"), "utf8"), /native/);
    await reader.stable();
    await writeFile(join(root, host.path), "tampered");
    await assert.rejects(reader.stable(), /Evidence changed/);
  }));

test("historical recovery cannot conceal changes to frozen rendering code", () =>
  fixture(async ({ root, output, source }) => {
    await writeFile(join(root, "src/renderer/webgpu-renderer.ts"), "changed pixels");
    await assert.rejects(
      preserveFrozenProjectSource({ root, output }, source, new M0Evidence(root)),
      /Frozen renderer changed/,
    );
  }));

test("shader catalog additions preserve every historical program definition", () =>
  fixture(async ({ root, output, source, originals }) => {
    const manifest = JSON.parse(originals["shaders/manifest.json"]);
    manifest.programs.native = { fragments: ["native"] };
    manifest.fragments.native = "native.wgsl";
    await writeFile(join(root, "shaders/manifest.json"), JSON.stringify(manifest));
    await preserveFrozenProjectSource({ root, output }, source, new M0Evidence(root));
    manifest.programs.scene.fragments = ["native"];
    await writeFile(join(root, "shaders/manifest.json"), JSON.stringify(manifest));
    await assert.rejects(
      preserveFrozenProjectSource(
        { root, output: join(root, "bad") },
        source,
        new M0Evidence(root),
      ),
      /Frozen shader entry changed/,
    );
  }));

test("missing historical validator remains explicit while mismatched identities and bytes fail", () =>
  fixture(async ({ root, source }) => {
    const pin = { path: "old-validator.exe", sha256: source.ir_cli_sha256 };
    const missing = await historicalProjectValidator(new M0Evidence(root), pin, source);
    assert.equal(missing.identity.original_bytes_available, false);
    assert.equal(missing.proof, undefined);
    await assert.rejects(
      historicalProjectValidator(new M0Evidence(root), { ...pin, sha256: "f".repeat(64) }, source),
    );
    await writeFile(join(root, pin.path), "replacement validator");
    await assert.rejects(
      historicalProjectValidator(new M0Evidence(root), pin, source),
      /Evidence SHA-256 differs/,
    );
    await writeFile(join(root, pin.path), "historical validator");
    assert.equal(
      (await historicalProjectValidator(new M0Evidence(root), pin, source)).identity
        .original_bytes_available,
      true,
    );
  }));

test("producer digests and unsafe paths cannot be repaired by Git recovery", () =>
  fixture(async ({ root, output, source }) => {
    await assert.rejects(
      preserveFrozenProjectSource(
        { root, output },
        { ...source, renderer_source_sha256: "f".repeat(64) },
        new M0Evidence(root),
      ),
      /Historical producer identity differs/,
    );
    const invalid = { ...source, files: [{ path: "../outside", sha256: "a".repeat(64) }] };
    invalid.renderer_source_sha256 = digest({
      files: invalid.files,
      bridge_sha256: invalid.bridge_sha256,
      ir_cli_sha256: invalid.ir_cli_sha256,
    });
    await assert.rejects(
      preserveFrozenProjectSource({ root, output }, invalid, new M0Evidence(root)),
      /safe checkout-relative paths/,
    );
  }));

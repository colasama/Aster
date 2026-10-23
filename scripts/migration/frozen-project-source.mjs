import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { digest } from "../parity/provenance.mjs";
import { evidencePath, sha256, validSha } from "./m0-evidence.mjs";
import { writeAtomicJson } from "./report.mjs";

/** Keep historical provenance distinct from the current decoder that audits frozen plans. */
export async function historicalProjectValidator(reader, pin, source) {
  evidencePath(pin.path);
  assert.equal(validSha(pin.sha256), validSha(source.ir_cli_sha256));
  const identity = {
    ...pin,
    role: "historical-capture-validator-identity",
    original_bytes_available: false,
  };
  let proof;
  try {
    const file = await reader.bytes(pin.path, pin.sha256);
    proof = { path: pin.path, sha256: file.sha256 };
    identity.original_bytes_available = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { identity, proof };
}

/** Freeze the original producer bytes independently of the evolving native application host. */
export async function preserveFrozenProjectSource(context, source, reader) {
  assert(/^[a-f0-9]{40}$/.test(source.commit), "Historical producer commit is required");
  assert(Array.isArray(source.files) && source.files.length > 0);
  assert.equal(new Set(source.files.map((file) => file.path)).size, source.files.length);
  assert.equal(
    source.renderer_source_sha256,
    digest({
      files: source.files,
      bridge_sha256: validSha(source.bridge_sha256),
      ir_cli_sha256: validSha(source.ir_cli_sha256),
    }),
    "Historical producer identity differs",
  );
  const root = await realpath(context.root),
    output = join(context.output, "frozen-project-source"),
    files = [],
    changed = [];
  // M11's paired benchmark driver and M12's type-only presentation import are host wiring.
  const migratedHosts = new Set([
    "src/renderer/diagnostics/gpu-benchmark.ts",
    "src/renderer/frame-cache/cached-beauty-presenter.ts",
  ]);
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  for (const entry of source.files) {
    evidencePath(entry.path);
    assert(!entry.path.includes("\0"));
    validSha(entry.sha256);
    let bytes, origin, currentBytes;
    const frozenRuntime =
      (entry.path.startsWith("src/renderer/") && !migratedHosts.has(entry.path)) ||
      (entry.path.startsWith("shaders/") && entry.path !== "shaders/manifest.json") ||
      entry.path === "src/core/rendering/render-export.ts";
    try {
      const current = await reader.bytes(entry.path);
      currentBytes = current.bytes;
      if (frozenRuntime)
        assert.equal(current.sha256, entry.sha256, `Frozen renderer changed: ${entry.path}`);
      if (current.sha256 === entry.sha256) {
        bytes = current.bytes;
        origin = "matching-checkout";
      } else changed.push({ path: entry.path, current_sha256: current.sha256 });
    } catch (error) {
      if (error.code !== "ENOENT" || frozenRuntime) throw error;
      changed.push({ path: entry.path, current_sha256: null });
    }
    if (!bytes) {
      bytes = execFileSync("git", ["show", `${source.commit}:${entry.path}`], {
        cwd: context.root,
        windowsHide: true,
        maxBuffer: 67108864,
        stdio: ["ignore", "pipe", "pipe"],
      });
      assert.equal(sha256(bytes), entry.sha256, `Historical producer bytes differ: ${entry.path}`);
      origin = "recorded-git-commit";
    }
    if (entry.path === "shaders/manifest.json") {
      assert(currentBytes, "Current shared shader manifest is required");
      const previous = JSON.parse(bytes),
        current = JSON.parse(currentBytes);
      for (const [field, value] of Object.entries(previous)) {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          for (const [name, definition] of Object.entries(value))
            assert.deepEqual(
              current[field]?.[name],
              definition,
              `Frozen shader entry changed: ${name}`,
            );
        } else
          assert.deepEqual(current[field], value, `Frozen shader manifest field changed: ${field}`);
      }
    }
    const destination = join(output, entry.path);
    evidencePath(local(destination));
    await mkdir(dirname(destination), { recursive: true });
    const member = relative(root, await realpath(dirname(destination)));
    assert(member && member !== ".." && !member.startsWith(`..${sep}`) && !isAbsolute(member));
    try {
      await writeFile(destination, bytes, { flag: "wx" });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    await reader.bytes(local(destination), entry.sha256);
    files.push({
      path: local(destination),
      original_path: entry.path,
      sha256: entry.sha256,
      origin,
    });
  }
  const manifest = join(output, "source.json");
  await writeAtomicJson(manifest, {
    kind: "authenticated-historical-project-producer",
    original_source: source,
    files,
    changed_current_files: changed,
  });
  const pin = await reader.bytes(local(manifest));
  return {
    path: local(manifest),
    sha256: pin.sha256,
    renderer_source_sha256: source.renderer_source_sha256,
    files,
    current_ts_files_match: changed.length === 0,
    changed_current_files: changed,
  };
}

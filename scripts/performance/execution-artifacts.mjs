import assert from "node:assert/strict";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { evidencePath, validSha } from "../migration/m0-evidence.mjs";
import { hashFile } from "../migration/source.mjs";
import { digest } from "../parity/provenance.mjs";

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Resolve every component, rejecting junctions as well as final-file symbolic links. */
class ArtifactFiles {
  constructor(root) {
    this.root = root;
  }

  member(path) {
    const member = relative(this.root, resolve(this.root, path)).replaceAll("\\", "/");
    return evidencePath(member);
  }

  artifact(path) {
    const member = this.member(path);
    assert(member.startsWith("artifacts/"), "Execution evidence must stay under artifacts");
    return member;
  }

  async existing(member, kind) {
    evidencePath(member);
    const parts = member.split("/");
    let absolute = this.root;
    for (const [index, part] of parts.entries()) {
      absolute = resolve(absolute, part);
      const info = await lstat(absolute);
      assert(!info.isSymbolicLink(), `Symbolic links are not execution evidence: ${member}`);
      assert(
        index === parts.length - 1 && kind === "file" ? info.isFile() : info.isDirectory(),
        `Unexpected execution artifact type: ${member}`,
      );
    }
    assert.equal(await realpath(absolute), absolute, "Execution artifact path was redirected");
    return absolute;
  }

  async directory(member) {
    const files = [];
    const visit = async (parent) => {
      const absolute = await this.existing(parent, "directory");
      for (const entry of await readdir(absolute, { withFileTypes: true })) {
        const path = `${parent}/${entry.name}`;
        if (entry.isDirectory()) await visit(path);
        else {
          const file = await this.existing(path, "file");
          files.push({ path, sha256: await hashFile(file) });
        }
      }
    };
    await visit(member);
    files.sort((left, right) => left.path.localeCompare(right.path, "en"));
    assert(files.length > 0, `Execution artifact directory is empty: ${member}`);
    return { directory: member, files, sha256: digest(files) };
  }

  async ensureDirectory(member) {
    evidencePath(member);
    let current = "";
    for (const part of member.split("/")) {
      current = current ? `${current}/${part}` : part;
      try {
        await mkdir(resolve(this.root, current));
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      await this.existing(current, "directory");
    }
  }

  async preserve(source, destination, expected) {
    const from = await this.existing(source, "file");
    await this.ensureDirectory(dirname(destination).replaceAll("\\", "/"));
    await copyFile(from, resolve(this.root, evidencePath(destination)), constants.COPYFILE_EXCL);
    const to = await this.existing(destination, "file");
    assert.equal(
      await hashFile(to),
      expected,
      "Preserved execution artifact differs from live bytes",
    );
    return { path: destination, sha256: expected };
  }
}

function validateSnapshot(snapshot) {
  assert.equal(snapshot.schema_version, 1);
  assert.equal(snapshot.kind, "performance-execution-artifacts");
  const run = evidencePath(snapshot.run_directory);
  assert(run.startsWith("artifacts/"), "Execution run must stay under artifacts");
  const web = evidencePath(snapshot.web.directory);
  assert(web.startsWith("artifacts/"), "Execution web must stay under artifacts");
  const runtime = evidencePath(snapshot.runtime.directory);
  assert.equal(runtime, `${run}/runtime`);
  assert(
    web !== runtime && !web.startsWith(`${runtime}/`) && !runtime.startsWith(`${web}/`),
    "Web and preserved runtime must be separate directories",
  );
  assert.equal(snapshot.runtime.live.electron_directory, "dist-electron");
  const bridge = evidencePath(snapshot.runtime.live.bridge_path);
  assert(/^target\/release\/aster-desktop-bridge(?:\.exe)?$/.test(bridge));
  const preservedBridge = `${runtime}/bridge/${basename(bridge)}`;
  for (const directory of [snapshot.web, snapshot.runtime]) {
    validSha(directory.sha256);
    assert(Array.isArray(directory.files) && directory.files.length > 0);
    assert.equal(new Set(directory.files.map((file) => file.path)).size, directory.files.length);
    for (const file of directory.files) {
      evidencePath(file.path);
      assert(
        file.path.startsWith(`${directory.directory}/`),
        "Evidence file escaped its directory",
      );
      validSha(file.sha256);
    }
    assert.equal(digest(directory.files), directory.sha256, "Execution artifact digest differs");
  }
  assert(snapshot.runtime.files.some((file) => file.path.startsWith(`${runtime}/dist-electron/`)));
  assert.equal(snapshot.runtime.files.filter((file) => file.path === preservedBridge).length, 1);
  assert(
    snapshot.runtime.files.every(
      (file) => file.path === preservedBridge || file.path.startsWith(`${runtime}/dist-electron/`),
    ),
    "Unexpected preserved runtime member",
  );
}

/** Audit only retained evidence; later recompilation of live Electron or bridge is irrelevant. */
export async function auditExecutionArtifacts(root, snapshot) {
  validateSnapshot(snapshot);
  const files = new ArtifactFiles(await realpath(resolve(root)));
  assert.deepEqual(
    await files.directory(snapshot.web.directory),
    snapshot.web,
    "Preserved web file set or bytes changed",
  );
  const { live: _live, ...runtime } = snapshot.runtime;
  assert.deepEqual(
    await files.directory(runtime.directory),
    runtime,
    "Preserved runtime file set or bytes changed",
  );
  return {
    status: "passed",
    web_files: snapshot.web.files.length,
    runtime_files: runtime.files.length,
    sha256: digest(snapshot),
  };
}

/** Preserve compiled bytes without changing the production process's live loading paths. */
export async function captureExecutionArtifacts(root, { webDirectory, runDirectory }) {
  const files = new ArtifactFiles(await realpath(resolve(root)));
  assert(typeof webDirectory === "string" && typeof runDirectory === "string");
  const run = files.artifact(runDirectory);
  const webPath = files.artifact(webDirectory);
  const runtimePath = `${run}/runtime`;
  assert(
    webPath !== runtimePath &&
      !webPath.startsWith(`${runtimePath}/`) &&
      !runtimePath.startsWith(`${webPath}/`),
    "Web and preserved runtime must be separate directories",
  );
  await files.existing(run, "directory");
  const web = await files.directory(webPath);
  const electron = await files.directory("dist-electron");
  const bridgePath = `target/release/aster-desktop-bridge${process.platform === "win32" ? ".exe" : ""}`;
  const bridgeHash = await hashFile(await files.existing(bridgePath, "file"));
  // The whole retained tree is new. A retry must use another run directory, never overwrite it.
  await mkdir(resolve(files.root, runtimePath));
  await files.existing(runtimePath, "directory");
  const preserved = [];
  for (const file of electron.files)
    preserved.push(await files.preserve(file.path, `${runtimePath}/${file.path}`, file.sha256));
  preserved.push(
    await files.preserve(bridgePath, `${runtimePath}/bridge/${basename(bridgePath)}`, bridgeHash),
  );
  preserved.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const snapshot = freeze({
    schema_version: 1,
    kind: "performance-execution-artifacts",
    run_directory: run,
    web,
    runtime: {
      directory: runtimePath,
      live: { electron_directory: electron.directory, bridge_path: bridgePath },
      files: preserved,
      sha256: digest(preserved),
    },
  });
  const assertUnchanged = async () => {
    await auditExecutionArtifacts(files.root, snapshot);
    assert.deepEqual(
      await files.directory(electron.directory),
      electron,
      "Live Electron file set or bytes changed during measurement",
    );
    assert.equal(
      await hashFile(await files.existing(bridgePath, "file")),
      bridgeHash,
      "Live bridge bytes changed during measurement",
    );
  };
  await assertUnchanged();
  return Object.freeze({ snapshot, assertUnchanged });
}

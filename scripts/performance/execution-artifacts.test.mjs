import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { auditExecutionArtifacts, captureExecutionArtifacts } from "./execution-artifacts.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "aster-execution-artifacts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (path, value = "fixture bytes") => {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, value);
  };
  const webDirectory = "artifacts/historical/web";
  const runDirectory = "artifacts/performance/new-run";
  const bridgePath = `target/release/aster-desktop-bridge${process.platform === "win32" ? ".exe" : ""}`;
  await write(
    `${webDirectory}/tests/performance/harness.html`,
    "<script src='/assets/main.js'></script>",
  );
  await write(`${webDirectory}/assets/main.js`, "// CPU-only fixture; not an executable renderer");
  await write("dist-electron/electron/mp4-export.js", "// CPU-only fixture host");
  await write("dist-electron/src/desktop/preferences.js", "// CPU-only fixture preferences");
  await write(bridgePath, Buffer.from([1, 2, 3, 4]));
  await mkdir(join(root, runDirectory), { recursive: true });
  const capture = () => captureExecutionArtifacts(root, { webDirectory, runDirectory });
  return { root, write, webDirectory, runDirectory, bridgePath, capture };
}

test("retained evidence is byte exact and remains auditable after live builds disappear", async (t) => {
  const data = await fixture(t);
  const { snapshot, assertUnchanged } = await data.capture();
  assert.equal(snapshot.web.directory, data.webDirectory);
  assert.equal(snapshot.web.files.length, 2);
  assert.equal(snapshot.runtime.files.length, 3);
  for (const file of snapshot.runtime.files) {
    const live = file.path.includes("/runtime/dist-electron/")
      ? file.path.slice(file.path.indexOf("dist-electron/"))
      : data.bridgePath;
    assert.deepEqual(
      await readFile(join(data.root, file.path)),
      await readFile(join(data.root, live)),
    );
  }
  assert.throws(() => {
    snapshot.runtime.files[0].sha256 = "0".repeat(64);
  }, TypeError);
  await assertUnchanged();
  await rm(join(data.root, "dist-electron"), { recursive: true });
  await rm(join(data.root, "target"), { recursive: true });
  const audit = await auditExecutionArtifacts(data.root, JSON.parse(JSON.stringify(snapshot)));
  assert.equal(audit.status, "passed");
  assert.equal(audit.web_files, 2);
  assert.equal(audit.runtime_files, 3);
  await assert.rejects(assertUnchanged, /ENOENT/);
});

test("post-measurement checks reject changed, missing and added live files", async (t) => {
  for (const problem of [
    "changed-host",
    "added-host",
    "missing-host",
    "changed-bridge",
    "changed-web",
  ]) {
    await t.test(problem, async (child) => {
      const data = await fixture(child);
      const captured = await data.capture();
      if (problem === "changed-host")
        await data.write("dist-electron/electron/mp4-export.js", "changed");
      if (problem === "added-host") await data.write("dist-electron/unrecorded.js");
      if (problem === "missing-host")
        await rm(join(data.root, "dist-electron/electron/mp4-export.js"));
      if (problem === "changed-bridge") await data.write(data.bridgePath, "changed bridge");
      if (problem === "changed-web")
        await data.write(`${data.webDirectory}/assets/main.js`, "changed web");
      await assert.rejects(captured.assertUnchanged, /changed/);
      if (problem !== "changed-web")
        assert.equal(
          (await auditExecutionArtifacts(data.root, captured.snapshot)).status,
          "passed",
        );
    });
  }
});

test("frozen audits reject modified, missing and added preserved files", async (t) => {
  for (const problem of [
    "changed-runtime",
    "added-runtime",
    "missing-runtime",
    "added-web",
    "missing-web",
  ]) {
    await t.test(problem, async (child) => {
      const data = await fixture(child);
      const { snapshot, assertUnchanged } = await data.capture();
      if (problem === "changed-runtime")
        await data.write(snapshot.runtime.files[0].path, "changed");
      if (problem === "added-runtime")
        await data.write(`${snapshot.runtime.directory}/unrecorded.js`);
      if (problem === "missing-runtime") await rm(join(data.root, snapshot.runtime.files[0].path));
      if (problem === "added-web") await data.write(`${data.webDirectory}/injected.js`);
      if (problem === "missing-web") await rm(join(data.root, snapshot.web.files[0].path));
      await assert.rejects(() => auditExecutionArtifacts(data.root, snapshot), /changed/);
      await assert.rejects(assertUnchanged, /changed/);
    });
  }
});

test("runtime preservation is create-new and rejects paths outside the checkout", async (t) => {
  const data = await fixture(t);
  const captured = await data.capture();
  await assert.rejects(data.capture, /EEXIST/);
  await captured.assertUnchanged();
  await assert.rejects(
    captureExecutionArtifacts(data.root, {
      webDirectory: dirname(data.root),
      runDirectory: data.runDirectory,
    }),
    /safe checkout-relative/,
  );
  await assert.rejects(
    captureExecutionArtifacts(data.root, {
      webDirectory: data.webDirectory,
      runDirectory: "dist-electron",
    }),
    /under artifacts/,
  );
  const malformed = structuredClone(captured.snapshot);
  malformed.runtime.directory = "artifacts/other-runtime";
  await assert.rejects(() => auditExecutionArtifacts(data.root, malformed));
});

test("junctions are rejected at web, live host, bridge and retained directory boundaries", async (t) => {
  for (const problem of ["web", "run", "host", "bridge", "preserved"]) {
    await t.test(problem, async (child) => {
      const data = await fixture(child);
      const target = join(data.root, "redirected");
      await mkdir(target);
      if (problem === "preserved") {
        const captured = await data.capture();
        const path = join(data.root, captured.snapshot.runtime.directory, "dist-electron");
        await rm(path, { recursive: true });
        await symlink(target, path, "junction");
        await assert.rejects(
          () => auditExecutionArtifacts(data.root, captured.snapshot),
          /Symbolic links/,
        );
        return;
      }
      const member =
        problem === "web"
          ? data.webDirectory
          : problem === "run"
            ? data.runDirectory
            : problem === "host"
              ? "dist-electron/src"
              : "target/release";
      const path = join(data.root, member);
      await rm(path, { recursive: true });
      await symlink(target, path, "junction");
      await assert.rejects(data.capture, /Symbolic links/);
    });
  }
});

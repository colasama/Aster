import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CaptureDesktopAccess, DesktopBridgeClient } from "./desktop-bridge.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "aster-capture-bridge-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "project");
  await mkdir(directory);
  const projectPath = join(directory, "fixture.json");
  const assetPath = join(directory, "media.bin");
  await writeFile(assetPath, "media");
  await writeFile(projectPath, JSON.stringify({ source: { relativePath: "media.bin" } }));
  const assignment = { case: { id: "fixture" }, projectPath };
  const calls = [];
  const client = {
    invoke: async (...args) => {
      calls.push(args);
      return {};
    },
  };
  const assets = new Map();
  const access = new CaptureDesktopAccess({ root, assignments: [assignment] }, client, assets);
  return { root, assignment, calls, assets, access, assetPath };
}

test("standalone fixtures are hydrated read-only with a precise asset allowlist", async (t) => {
  const { assignment, access, assets, assetPath, calls } = await fixture(t);
  const original = await readFile(assignment.projectPath, "utf8");
  await access.prepare(assignment);
  const project = await access.invoke("load_project", { path: assignment.projectPath });
  assert.equal(project.source.resolvedPath, assetPath);
  assert(assets.has(process.platform === "win32" ? assetPath.toLowerCase() : assetPath));
  assert.equal(await readFile(assignment.projectPath, "utf8"), original);
  assert.deepEqual(calls, []);
  await assert.rejects(
    access.invoke("save_project", { path: assignment.projectPath }),
    /not permitted/,
  );
  await assert.rejects(access.invoke("load_project", { path: assetPath }), /outside/);
  await assert.rejects(access.prepare({ ...assignment }), /Unknown/);
});

test("relative media traversal is rejected before it becomes fetchable", async (t) => {
  const { root, assignment, access, assets } = await fixture(t);
  await writeFile(join(root, "outside.bin"), "outside");
  await writeFile(
    assignment.projectPath,
    JSON.stringify({ storage: { relativePath: "../outside.bin" } }),
  );
  await access.prepare(assignment);
  await assert.rejects(access.invoke("load_project", { path: assignment.projectPath }), /escapes/);
  assert.equal(assets.size, 0);
});

test("portable project.json preserves inline payloads without the native bundle loader", async (t) => {
  const { root, assignment, access, calls } = await fixture(t);
  assignment.projectPath = join(root, "project", "project.json");
  const project = {
    mediaImports: {
      payloads: [
        { id: "image", storage: { type: "inline", dataUrl: "data:image/png;base64,iVBORw0KGgo=" } },
      ],
    },
  };
  const contents = JSON.stringify(project);
  await writeFile(assignment.projectPath, contents);
  await access.prepare(assignment);
  assert.deepEqual(await access.invoke("load_project", { path: assignment.projectPath }), project);
  assert.deepEqual(calls, []);
  assert.equal(await readFile(assignment.projectPath, "utf8"), contents);
});

test("assigned directories retain the production native bundle loader", async (t) => {
  const { root, assignment, access, calls } = await fixture(t);
  assignment.projectPath = join(root, "project");
  await access.prepare(assignment);
  await access.invoke("load_project", { path: assignment.projectPath });
  assert.deepEqual(calls, [["load_project", { path: assignment.projectPath }]]);
});

test("plugin installation and runtime access are limited to declared case plugins", async (t) => {
  const { root, assignment, access, calls } = await fixture(t);
  await mkdir(join(root, "plugin"));
  await writeFile(
    join(root, "plugin", "plugin.toml"),
    '[plugin]\nid = "org.aster.test"\n[other]\nid = "invalid"\n',
  );
  assignment.case.plugins = ["plugin"];
  await access.prepare(assignment);
  await access.prepare(assignment);
  await access.invoke("load_plugin_runtime", { pluginIds: ["org.aster.test"] });
  await assert.rejects(access.invoke("load_plugin_runtime", { pluginIds: ["other"] }), /outside/);
  assert.deepEqual(
    calls.map(([name]) => name),
    ["install_plugin", "load_plugin_runtime"],
  );
});

function client(t, code, options = {}) {
  const bridge = new DesktopBridgeClient(process.execPath, "unused", {
    args: ["-e", code],
    timeoutMs: 2000,
    ...options,
  });
  t.after(() => bridge.dispose());
  return bridge;
}

test("bridge protocol correlates responses and propagates command failures", async (t) => {
  const bridge = client(
    t,
    `require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    process.stdout.write(JSON.stringify(request.command === 'fail' ? { id: request.id, error: 'native failure' } : { id: request.id, result: request.args }) + '\\n');
  });`,
  );
  assert.deepEqual(await bridge.invoke("echo", { input: 3 }), { input: 3 });
  await assert.rejects(bridge.invoke("fail"), /native failure/);
});

test("invalid bridge protocol, process exit, and timeouts reject pending work", async (t) => {
  const invalid = client(
    t,
    "process.stdin.once('data', () => process.stdout.write('invalid\\n')); ",
  );
  await assert.rejects(invalid.invoke("read"), /JSON|Unexpected/);
  const exited = client(t, "process.stdin.once('data', () => process.exit(7));");
  await assert.rejects(exited.invoke("read"), /exited/);
  const hung = client(t, "process.stdin.resume();", { timeoutMs: 50 });
  await assert.rejects(hung.invoke("read"), /timed out/);
  hung.dispose();
  await assert.rejects(hung.invoke("read"), /unavailable/);
});

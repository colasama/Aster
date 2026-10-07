import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { auditSharedShaderSources } from "./shared-shaders.mjs";

async function fixture(t, source = "export const count = 1;", file = "src/main.ts") {
  const root = await mkdtemp(join(tmpdir(), "aster-shared-shaders-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, dirname(file)), { recursive: true });
  await mkdir(join(root, "shaders"));
  await writeFile(join(root, file), source);
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { jsx: "preserve", noLib: true }, include: ["src"] }),
  );
  const manifest = {
    schema_version: 1,
    fragments: { helper: "helper.wgsl" },
    programs: { helper: { fragments: ["helper"], entry_points: [], overrides: {} } },
  };
  await writeFile(join(root, "shaders/manifest.json"), JSON.stringify(manifest));
  await writeFile(join(root, "shaders/helper.wgsl"), "fn helper() -> f32 { return 1.0; }\n");
  return { root, manifest };
}

test("audits the full current src tree and the actual shared manifest", async () => {
  const report = await auditSharedShaderSources(resolve(import.meta.dirname, "../.."));
  assert.equal(report.status, "passed");
  assert(report.file_count > 700);
  assert(report.literal_count > 10000);
  assert(report.assertion_count > 0);
  assert.equal(report.inline_wgsl_count, 0);
  assert.equal(report.source_files.length, report.file_count);
  assert(report.shader_files.length > 50);
  assert.equal(report.manifest.program_count, 27);
  assert.match(report.source_sha256, /^[a-f0-9]{64}$/);
});

test("allows short assertion operands and non-WGSL plugin mocks without skipping test files", async (t) => {
  const { root } = await fixture(
    t,
    [
      'const sources = {"compute.wgsl": "updated compute", "render.wgsl": "render"};',
      'expect(shader).toContain("fn helper(");',
      'expect(bindings).toEqual([[0, "var<uniform> settings: Settings"]]);',
      `expect(shader).not.toContain(\`@vertex fn \${mode}_vertex\`);`,
      'const view = <div>{"ordinary UI text"}</div>;',
    ].join("\n"),
    "src/example.test.tsx",
  );
  const report = await auditSharedShaderSources(root);
  assert.equal(report.file_count, 1);
  assert.equal(report.assertion_count, 3);
});

test("rejects marked, unmarked and split shader implementations including test fixtures", async (t) => {
  const sources = [
    "const shader = /* wgsl */ `placeholder`;",
    `const shader = wgsl\`\${runtime}\`;`,
    'const shader = "@compute @workgroup_size(1) fn run() {}";',
    "const shader = `struct Settings { amount: f32, }`;",
    'const shader = "@com" + "pute @work" + "group_size(1) f" + "n run() {}";',
    'const shader = ["@com", "pute @work", "group_size(1) f", "n run() {}"].join("");',
    `const shader = \`@\${stage} fn \${entry}() { \${body} }\`;`,
    'expect(shader).toContain("fn helper() -> f32 { return 1.0; }");',
  ];
  for (const source of sources) {
    const { root } = await fixture(t, source, "src/shader.test.ts");
    await assert.rejects(
      auditSharedShaderSources(root),
      /Inline WGSL is forbidden: src\/shader\.test\.ts:1/,
    );
  }
});

test("rejects literal-derived compiler inputs even when syntax is supplied by interpolation", async (t) => {
  for (const code of [
    '"placeholder"',
    `\`\${runtime}\``,
    '"prefix" + runtime',
    '[runtime, "suffix"].join("")',
    'enabled ? "placeholder" : runtime',
  ]) {
    const { root } = await fixture(t, `device.createShaderModule({code: ${code}});`);
    await assert.rejects(auditSharedShaderSources(root), /Literal-derived createShaderModule code/);
  }
  const computed = await fixture(t, 'device["createShaderModule"](({["code"]: "placeholder"}));');
  await assert.rejects(
    auditSharedShaderSources(computed.root),
    /Literal-derived createShaderModule code/,
  );
});

test("fails closed on unreadable inputs and TS parse errors", async (t) => {
  const missing = await fixture(t);
  await rm(join(missing.root, "src"), { recursive: true });
  await assert.rejects(auditSharedShaderSources(missing.root), /ENOENT/);
  const broken = await fixture(t, "const broken = ;");
  await assert.rejects(auditSharedShaderSources(broken.root), /Cannot parse shared-shader source/);
});

test("requires exact disk coverage and reachable fragment IDs", async (t) => {
  for (const change of ["extra", "missing", "unused", "unknown", "unsafe"]) {
    const { root, manifest } = await fixture(t);
    if (change === "extra") await writeFile(join(root, "shaders/extra.wgsl"), "extra");
    if (change === "missing") await rm(join(root, "shaders/helper.wgsl"));
    if (change === "unused") manifest.fragments.alias = "helper.wgsl";
    if (change === "unknown") manifest.programs.helper.fragments.push("absent");
    if (change === "unsafe") manifest.fragments.helper = "../helper.wgsl";
    await writeFile(join(root, "shaders/manifest.json"), JSON.stringify(manifest));
    await assert.rejects(auditSharedShaderSources(root), /fragment|fragment paths/);
  }
});

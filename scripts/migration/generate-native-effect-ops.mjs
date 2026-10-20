import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { createServer, parseAst } from "vite";

// A development-time translation only. Generated kernels execute directly in Rust.
const root = process.cwd();
const directory = "crates/aster-eval/src/effects/program";
const phase = process.argv[2] ?? "color";
assert(["color", "spatial", "all"].includes(phase));
const categories = new Set(["Color Correction", "Channel", "Keying", "Matte", "Looks"]);
if (phase !== "color")
  for (const name of ["Blur & Sharpen", "Distort", "Transform", "Perspective"])
    categories.add(name);
const server = await createServer({
  root,
  configFile: false,
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, watch: null, hmr: false, ws: false },
  appType: "custom",
});
try {
  const registry = (await server.ssrLoadModule("/src/effects/registry.ts")).EFFECT_REGISTRY;
  const opcodes = (await server.ssrLoadModule("/src/renderer/effects/effect-opcodes.ts"))
    .EffectOpcode;
  const accepted = new Set(
    registry
      .filter(
        (e) =>
          phase === "all" ||
          categories.has(e.category) ||
          (phase !== "color" && ["glow", "bloom"].includes(e.type)),
      )
      .map((e) => e.type),
  );
  const pending = new Map();
  const sources = [],
    supported = [],
    modules = [];
  await mkdir(join(root, directory), { recursive: true });
  const files = [
    "src/renderer/effects/effect-program.ts",
    ...(await readdir("src/renderer/effects/programs"))
      .filter((p) => p.endsWith(".ts") && !p.endsWith(".test.ts"))
      .sort()
      .map((p) => `src/renderer/effects/programs/${p}`),
  ];
  function number(value) {
    assert(Number.isFinite(value));
    return Number.isInteger(value) ? `${value}.0` : String(value);
  }
  for (const file of files) {
    const raw = await readFile(file, "utf8"),
      code = stripTypeScriptTypes(raw),
      ast = parseAst(code);
    sources.push({ path: file, sha256: createHash("sha256").update(raw).digest("hex") });
    const fn =
      ast.body.find(
        (node) =>
          node.type === "ExportNamedDeclaration" &&
          node.declaration?.type === "FunctionDeclaration" &&
          node.declaration.id.name !== "compileEffectProgram",
      )?.declaration ??
      ast.body.find(
        (node) => node.type === "FunctionDeclaration" && node.id.name === "compileEffect",
      );
    assert(fn, file);
    const sw = fn.body.body.find((node) => node.type === "SwitchStatement");
    const helpers = new Map(
      fn.body.body
        .filter((n) => n.type === "VariableDeclaration")
        .flatMap((n) => n.declarations)
        .filter((n) => n.init?.type === "ArrowFunctionExpression")
        .map((n) => [n.id.name, n.init]),
    );
    const main = file.endsWith("/effects/effect-program.ts");
    function expression(node, bindings = new Map()) {
      if (node.type === "Native") return node.code;
      if (node.type === "Literal")
        return typeof node.value === "string" ? JSON.stringify(node.value) : number(node.value);
      if (node.type === "Identifier") {
        if (bindings.has(node.name)) return expression(bindings.get(node.name));
        if (node.name === "time") return "frame.time";
      }
      if (node.type === "UnaryExpression" && ["-", "+"].includes(node.operator))
        return `${node.operator === "+" ? "" : "-"}${expression(node.argument, bindings)}`;
      if (
        node.type === "BinaryExpression" &&
        ["+", "-", "*", "/", ">", "<", ">=", "<=", "===", "!=="].includes(node.operator)
      )
        return `(${expression(node.left, bindings)} ${node.operator.replace("===", "==").replace("!==", "!=")} ${expression(node.right, bindings)})`;
      if (node.type === "ConditionalExpression")
        return `(if ${expression(node.test, bindings)} { ${expression(node.consequent, bindings)} } else { ${expression(node.alternate, bindings)} })`;
      if (
        node.type === "MemberExpression" &&
        node.object.name === "Math" &&
        node.property.name === "PI"
      )
        return "std::f64::consts::PI";
      if (node.type === "CallExpression") {
        if (node.callee.type === "MemberExpression" && node.callee.property.name === "map") {
          const callback = node.arguments[0];
          assert(callback.type === "ArrowFunctionExpression" && callback.params.length === 1);
          const name = callback.params[0].name;
          const nested = new Map(bindings);
          nested.set(name, { type: "Native", code: name });
          const body = expression(callback.body, nested);
          return `(${expression(node.callee.object, bindings)}).map(|${name}| ${callback.body.type === "BinaryExpression" ? body.slice(1, -1) : body})`;
        }
        const name = node.callee.name;
        if (name === "value")
          return `frame.value(${expression(node.arguments[0], bindings)}, ${node.arguments[1] ? expression(node.arguments[1], bindings) : "0.0"})`;
        if (name === "degrees" && main)
          return `((${expression(node.arguments[0], bindings)} * std::f64::consts::PI) / 180.0)`;
        if (name === "colorChannels")
          return `EffectFrame::color_channels(${expression(node.arguments[0], bindings)})`;
        if (helpers.has(name)) {
          const helper = helpers.get(name),
            parameters = new Map(bindings);
          helper.params.forEach((p, i) => {
            parameters.set(p.name ?? p.left.name, node.arguments[i] ?? p.right);
          });
          return expression(helper.body, parameters);
        }
        if (node.callee.type === "MemberExpression" && node.callee.object.name === "Math") {
          const name = node.callee.property.name;
          if (name === "max" || name === "min")
            return `crate::expression::NumericFunction::${name === "max" ? "maximum" : "minimum"}(${expression(node.arguments[0], bindings)}, ${expression(node.arguments[1], bindings)})`;
          if (name === "round")
            return `crate::expression::NumericFunction::round(${expression(node.arguments[0], bindings)})`;
        }
      }
      throw Error(`Unsupported ${node.type} in ${file}: ${code.slice(node.start, node.end)}`);
    }
    const arms = [];
    for (const entry of sw.cases) {
      const type = entry.test?.value;
      if (!accepted.has(type)) continue;
      // Complex kernels are maintained separately; never silently generate a partial operation.
      if (type === "fast-bokeh") {
        supported.push(type);
        continue;
      }
      if (type === "multi-stop-gradient") {
        supported.push(type);
        continue;
      }
      assert(
        entry.consequent.every((n) =>
          ["ExpressionStatement", "ReturnStatement", "BreakStatement"].includes(n.type),
        ),
        type,
      );
      const calls = entry.consequent
        .filter((n) => n.type === "ExpressionStatement")
        .map((n) => n.expression);
      assert.equal(calls.length, 1, type);
      const call = calls[0];
      assert.equal(call.callee.name, "emit");
      const opcode = opcodes[call.arguments[0].property.name];
      assert(Number.isInteger(opcode));
      const values = [],
        locals = [];
      for (const arg of call.arguments[1].elements) {
        if (arg.type !== "SpreadElement") values.push(expression(arg));
        else {
          let value;
          if (type === "lut")
            value = locals.length ? "frame.lut_domain_max" : "frame.lut_domain_min";
          else value = expression(arg.argument);
          const name = `vector_${locals.length}`;
          locals.push(`let ${name} = ${value};`);
          for (let i = 0; i < 3; i++) values.push(`${name}[${i}]`);
        }
      }
      assert(values.length <= 15, type);
      while (values.length < 15) values.push("0.0");
      arms.push(
        `            ${JSON.stringify(type)} => { ${locals.join(" ")} Some([${number(opcode)}, ${values.join(", ")}]) },`,
      );
      supported.push(type);
    }
    if (!arms.length) continue;
    const name = main
      ? "base"
      : file
          .split("/")
          .at(-1)
          .replace("effect-program-", "")
          .replace(".ts", "")
          .replaceAll("-", "_");
    for (let offset = 0; offset < arms.length; offset += 24) {
      const part = arms.length > 24 ? `${name}_${offset / 24}` : name;
      modules.push(part);
      pending.set(
        join(root, directory, `${part}.rs`),
        `// Generated by scripts/migration/generate-native-effect-ops.mjs from ${file}.\nuse super::EffectKernels;\nuse crate::EffectFrame;\nimpl EffectKernels {\n    pub(super) fn ${part}(effect_type: &str, frame: &EffectFrame) -> Option<[f64; 16]> {\n        match effect_type {\n${arms.slice(offset, offset + 24).join("\n")}\n            _ => None,\n        }\n    }\n}\n`,
      );
    }
  }
  if (accepted.has("fast-bokeh")) modules.push("bokeh");
  if (accepted.has("multi-stop-gradient")) modules.push("gradient");
  assert.equal(new Set(supported).size, supported.length);
  const enumSource = await readFile("src/renderer/effects/effect-opcodes.ts", "utf8");
  sources.push({
    path: "src/renderer/effects/effect-opcodes.ts",
    sha256: createHash("sha256").update(enumSource).digest("hex"),
  });
  for (const file of await readdir("src/effects", { recursive: true })) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const path = `src/effects/${file.replaceAll("\\", "/")}`,
      bytes = await readFile(path);
    sources.push({ path, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const catalogs = [];
  const executions = new Map();
  for (const effect of registry) {
    assert(["fused-pixel", "multi-pass", "compute", "temporal"].includes(effect.execution));
    if (!executions.has(effect.execution)) executions.set(effect.execution, []);
    executions.get(effect.execution).push(JSON.stringify(effect.type));
  }
  pending.set(
    join(root, directory, "execution.rs"),
    `// Generated execution metadata; source definitions remain pinned in source-manifest.json.\nuse super::EffectProgram;\nimpl EffectProgram {\n    pub(crate) fn execution(effect_type: &str) -> Option<&'static str> {\n        match effect_type {\n${[...executions].map(([kind, types]) => `            ${types.join(" | ")} => Some(${JSON.stringify(kind)}),`).join("\n")}\n            _ => None,\n        }\n    }\n}\n`,
  );
  for (let bucket = 0; bucket < 4; bucket++) {
    const name = `catalog_${bucket}`;
    catalogs.push(name);
    const metadata = registry
      .filter((e) => e.type.charCodeAt(0) % 4 === bucket)
      .map((effect) => {
        const definitions = effect.parameters
          .filter((p) => p.unit === "px")
          .map(
            (p) =>
              `PixelParameter { key: ${JSON.stringify(p.key)}.into(), default_value: ${number(p.defaultValue)} }`,
          );
        return `            ${JSON.stringify(effect.type)} => Some(vec![${definitions.join(", ")}]),`;
      });
    pending.set(
      join(root, directory, `${name}.rs`),
      `// Generated effect pixel-unit metadata.\nuse crate::PixelParameter;\nuse super::catalog::EffectCatalog;\nimpl EffectCatalog {\n    pub(super) fn ${name}(effect_type: &str) -> Option<Vec<PixelParameter>> {\n        match effect_type {\n${metadata.join("\n")}\n            _ => None,\n        }\n    }\n}\n`,
    );
  }
  pending.set(
    join(root, directory, "catalog.rs"),
    `// Generated effect catalog dispatch.\nuse crate::PixelParameter;\npub(super) struct EffectCatalog;\nimpl EffectCatalog {\n    pub fn pixels(effect_type: &str) -> Option<Vec<PixelParameter>> {\n        match effect_type.as_bytes().first().map(|b| b % 4) {\n${catalogs.map((n, i) => `            Some(${i}) => Self::${n}(effect_type),`).join("\n")}\n            _ => None,\n        }\n    }\n}\n`,
  );
  pending.set(
    join(root, directory, "kernels.rs"),
    `// Generated kernel dispatch.\nuse crate::EffectFrame;\npub(super) struct EffectKernels;\nimpl EffectKernels {\n    pub fn operation(effect_type: &str, frame: &EffectFrame) -> Option<[f64; 16]> {\n${modules.map((name, i) => `${i ? "            .or_else(|| " : "        "}Self::${name}(effect_type, frame)${i ? ")" : ""}`).join("\n")}\n    }\n}\n`,
  );
  pending.set(
    join(root, directory, "modules.rs"),
    `${[...modules, ...catalogs, "execution"].map((name) => `mod ${name};`).join("\n")}\n`,
  );
  const generator = "scripts/migration/generate-native-effect-ops.mjs";
  sources.push({
    path: generator,
    sha256: createHash("sha256")
      .update(await readFile(generator))
      .digest("hex"),
  });
  for (const [path, content] of pending) await writeFile(path, content);
  execFileSync(
    "rustfmt",
    [
      "--edition",
      "2024",
      ...[...modules, ...catalogs, "catalog", "kernels", "modules", "execution"].map((n) =>
        join(root, directory, `${n}.rs`),
      ),
    ],
    { windowsHide: true },
  );
  await writeFile(
    join(root, directory, "source-manifest.json"),
    `${JSON.stringify({ version: 1, phase, supported: supported.sort(), sources }, null, 2)}\n`,
  );
  console.log(JSON.stringify({ phase, effects: supported.length, modules }));
} finally {
  await server.close();
}

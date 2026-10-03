import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { API } from "typescript/unstable/sync";
import { inspectShaderLiterals } from "./shared-shader-syntax.mjs";

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function filesUnder(root, directory, pattern) {
  const files = [];
  const visit = async (path) => {
    for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) await visit(child);
      else if (!entry.isFile()) throw new Error(`Unsupported shared-shader audit input: ${child}`);
      else if (pattern.test(entry.name)) files.push(child);
    }
  };
  await visit(directory);
  return files.sort();
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${label}`);
  return value;
}

async function catalogCoverage(root) {
  const bytes = await readFile(join(root, "shaders/manifest.json"));
  const manifest = object(JSON.parse(bytes.toString("utf8")), "shader manifest");
  const fragments = object(manifest.fragments, "shader fragments");
  const programs = object(manifest.programs, "shader programs");
  if (
    manifest.schema_version !== 1 ||
    !Object.keys(fragments).length ||
    !Object.keys(programs).length
  )
    throw new Error("Empty or unsupported shared shader catalog");
  const declared = new Set();
  for (const [id, path] of Object.entries(fragments)) {
    if (
      !id ||
      typeof path !== "string" ||
      !path.endsWith(".wgsl") ||
      /[\\:]/.test(path) ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw new Error(`Unsafe shared shader fragment: ${id}`);
    declared.add(`shaders/${path}`);
  }
  const paths = await filesUnder(root, "shaders", /\.wgsl$/);
  if (JSON.stringify([...declared].sort()) !== JSON.stringify(paths))
    throw new Error("Shared shader files do not exactly match manifest fragment paths");
  const used = new Set();
  for (const [id, program] of Object.entries(programs)) {
    if (!id || !Array.isArray(program?.fragments) || !program.fragments.length)
      throw new Error(`Invalid shared shader recipe: ${id}`);
    for (const entry of program.fragments) {
      if (typeof entry === "string") {
        if (!Object.hasOwn(fragments, entry)) throw new Error(`Unknown shader fragment: ${entry}`);
        used.add(entry);
      } else {
        const item = object(entry, "shader recipe item");
        const value = manifest.constants?.[item.constant];
        if (
          Object.keys(item).length !== 1 ||
          typeof item.constant !== "string" ||
          !Number.isInteger(value) ||
          value < 0 ||
          value > 0xffff_ffff
        )
          throw new Error(`Invalid shader recipe constant: ${id}`);
      }
    }
  }
  for (const id of Object.keys(fragments))
    if (!used.has(id)) throw new Error(`Unused shared shader fragment: ${id}`);
  const files = [];
  for (const path of paths) files.push({ path, sha256: hash(await readFile(join(root, path))) });
  return {
    manifest: {
      path: "shaders/manifest.json",
      sha256: hash(bytes),
      fragment_count: Object.keys(fragments).length,
      program_count: Object.keys(programs).length,
    },
    shader_files: files,
    shader_sources_sha256: hash(JSON.stringify(files)),
    coverage: { disk_matches_manifest: true, all_fragments_referenced: true },
  };
}

export async function auditSharedShaderSources(root) {
  root = resolve(root);
  const paths = await filesUnder(root, "src", /\.[cm]?tsx?$/);
  if (!paths.length) throw new Error("No TS/TSX source files were found for shared shader audit");
  const contents = new Map();
  const files = [];
  for (const path of paths) {
    const bytes = await readFile(join(root, path));
    contents.set(path, new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    files.push({ path, sha256: hash(bytes) });
  }
  const catalog = await catalogCoverage(root);
  const api = new API({ cwd: root });
  let snapshot;
  let literalCount = 0;
  let assertionCount = 0;
  const violations = [];
  try {
    snapshot = api.updateSnapshot({ openFiles: paths.map((path) => join(root, path)) });
    for (const path of paths) {
      const absolute = join(root, path);
      const program = snapshot.getDefaultProjectForFile(absolute)?.program;
      const file = program?.getSourceFile(absolute);
      if (!file || file.text !== contents.get(path))
        throw new Error(`Unparsed or changed shared-shader source: ${path}`);
      const diagnostics = program.getSyntacticDiagnostics(absolute);
      if (diagnostics.length)
        throw new Error(
          `Cannot parse shared-shader source ${path}: ${diagnostics.map((item) => item.text).join("; ")}`,
        );
      const result = inspectShaderLiterals(file);
      literalCount += result.literal_count;
      assertionCount += result.assertion_count;
      violations.push(...result.violations.map((item) => ({ path, ...item })));
    }
  } finally {
    snapshot?.dispose();
    api.close();
  }
  if (violations.length)
    throw new Error(
      `Inline WGSL is forbidden: ${violations.map((item) => `${item.path}:${item.line} ${item.reason}`).join("; ")}`,
    );
  return {
    status: "passed",
    file_count: files.length,
    literal_count: literalCount,
    assertion_count: assertionCount,
    inline_wgsl_count: 0,
    source_files: files,
    source_sha256: hash(JSON.stringify(files)),
    ...catalog,
  };
}

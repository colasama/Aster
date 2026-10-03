import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { hashFile, sourceProvenance } from "../migration/source.mjs";

export function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function directoryHashes(directory) {
  const files = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile())
        files.push({
          path: relative(directory, child).split(sep).join("/"),
          sha256: await hashFile(child),
        });
      else throw new Error(`Unsupported non-file fixture resource: ${child}`);
    }
  }
  await visit(directory);
  return files.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

export async function captureSource(root) {
  const tree = await sourceProvenance(root);
  const tracked = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    },
  ).split("\0");
  const paths = [...new Set(tracked)]
    .filter(
      (path) =>
        /^(src\/|electron\/|shaders\/|scripts\/parity\/|scripts\/parity-capture\.mjs$|tests\/parity\/(capture[^/]*\.ts|harness\.html)$|pnpm-lock\.yaml$|vite\.config\.ts$)/.test(
          path,
        ) && !/\.test\.[cm]?[jt]s$/.test(path),
    )
    .sort();
  const files = [];
  for (const path of paths) files.push({ path, sha256: await hashFile(join(root, path)) });
  const extension = process.platform === "win32" ? ".exe" : "";
  const bridgeHash = await hashFile(
    join(root, "target", "release", `aster-desktop-bridge${extension}`),
  );
  return {
    commit: tree.commit,
    branch: tree.branch,
    dirty: tree.dirty,
    tree_sha256: tree.source_sha256,
    renderer_source_sha256: digest({ files, bridge_sha256: bridgeHash }),
    bridge_sha256: bridgeHash,
    files,
  };
}

export function captureFrames(item, composition) {
  const frames = [...item.frames];
  if (!item.sequence) return frames;
  const count = Math.ceil(
    (composition.duration * composition.frameRate.numerator) / composition.frameRate.denominator,
  );
  const seen = new Set(frames);
  for (const frame of item.frames) {
    for (const neighbor of [frame - 1, frame + 1]) {
      if (neighbor >= 0 && neighbor < count && !seen.has(neighbor)) {
        seen.add(neighbor);
        frames.push(neighbor);
      }
    }
  }
  return frames;
}

async function referencedFiles(project, directory) {
  const paths = new Set();
  const base = await realpath(directory);
  async function visit(value) {
    if (!value || typeof value !== "object") return;
    if (typeof value.runtimeUrl === "string")
      throw new Error("Persisted runtime URLs cannot establish reproducible capture resources");
    for (const field of ["relativePath", "externalPath", "resolvedPath"]) {
      if (typeof value[field] !== "string") continue;
      if (field === "relativePath" && isAbsolute(value[field]))
        throw new Error("Relative capture resource path must not be absolute");
      const path = await realpath(resolve(base, value[field]));
      const member = relative(base, path);
      if (member === ".." || member.startsWith(`..${sep}`) || isAbsolute(member))
        throw new Error("Capture resource escapes its project directory");
      if (!(await stat(path)).isFile()) throw new Error("Capture resource must be a regular file");
      paths.add(path);
    }
    for (const child of Object.values(value)) await visit(child);
  }
  await visit(project);
  const files = [];
  for (const path of [...paths].sort())
    files.push({ path: relative(base, path).split(sep).join("/"), sha256: await hashFile(path) });
  return files;
}

export async function captureAssignments(root, cases, env = process.env) {
  const resources = new Map();
  const assignments = [];
  for (const item of cases) {
    const owner = item.project === "env:ASTER_PERF_PROJECT";
    const projectPath = owner ? env.ASTER_PERF_PROJECT : resolve(root, item.project);
    if (!projectPath) {
      assignments.push({ case: item, unavailable: "ASTER_PERF_PROJECT is not set" });
      continue;
    }
    const information = await stat(projectPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (!information) {
      if (!owner) throw new Error(`Missing fixture: ${projectPath}; run pnpm parity:generate`);
      assignments.push({ case: item, unavailable: "Owner project is unavailable" });
      continue;
    }
    const projectFile = information.isDirectory() ? join(projectPath, "project.json") : projectPath;
    let resource = resources.get(projectFile);
    if (!resource) {
      const bytes = await readFile(projectFile);
      const project = JSON.parse(bytes.toString("utf8"));
      const assetsPath = join(dirname(projectFile), "assets");
      const hasAssets = await stat(assetsPath)
        .then((value) => value.isDirectory())
        .catch((error) => {
          if (error.code !== "ENOENT") throw error;
          return false;
        });
      resource = {
        project,
        project_sha256: createHash("sha256").update(bytes).digest("hex"),
        assets: hasAssets ? await directoryHashes(assetsPath) : [],
        referenced_files: await referencedFiles(project, dirname(projectFile)),
      };
      resources.set(projectFile, resource);
    }
    const composition = resource.project.compositions.find(
      (value) => value.id === item.composition,
    );
    if (!composition) throw new Error(`${item.id}: addressed composition is absent`);
    const plugins = [];
    for (const path of item.plugins ?? [])
      plugins.push({ path, files: await directoryHashes(resolve(root, path)) });
    const frames = captureFrames(item, composition);
    const inputs = {
      case: item,
      project_sha256: resource.project_sha256,
      assets: resource.assets,
      referenced_files: resource.referenced_files,
      plugins,
      frames,
    };
    assignments.push({
      case: item,
      frames,
      projectPath: resolve(projectPath),
      caseHash: digest(inputs),
      inputs,
    });
  }
  return assignments;
}

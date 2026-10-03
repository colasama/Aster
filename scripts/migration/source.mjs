import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

export async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function sourceProvenance(root) {
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trimEnd();
  const files = [
    ...new Set(git("ls-files", "--cached", "--others", "--exclude-standard", "-z").split("\0")),
  ]
    .filter(Boolean)
    .sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(`${file}\0`);
    try {
      const path = join(root, file);
      const info = await lstat(path);
      hash.update(info.isSymbolicLink() ? await readlink(path) : await hashFile(path));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      hash.update("<deleted>");
    }
    hash.update("\0");
  }
  const status = git("status", "--porcelain=v1", "--untracked-files=all");
  return {
    commit: git("rev-parse", "HEAD"),
    branch: git("branch", "--show-current"),
    dirty: status.length > 0,
    status: status.split("\n").filter(Boolean),
    source_sha256: hash.digest("hex"),
    source_file_count: files.length,
    source_scope: "git tracked and non-ignored untracked files, including deletions",
  };
}

export async function ownerProject(environment, platform = process.platform) {
  const env = { ...environment };
  let origin = "environment";
  if (env.ASTER_PERF_PROJECT === undefined && platform === "win32") {
    env.ASTER_PERF_PROJECT = "D:\\code\\SD04PV";
    origin = "primary-machine-default";
  }
  const path = env.ASTER_PERF_PROJECT ? resolve(env.ASTER_PERF_PROJECT) : null;
  let available = false;
  if (path) {
    available = await stat(join(path, "project.json"))
      .then((entry) => entry.isFile())
      .catch(() => false);
  }
  return {
    env,
    report: {
      path,
      origin,
      available,
      status: available ? "available" : "skipped",
      reason: available ? null : "Owner performance project or project.json is unavailable",
    },
  };
}

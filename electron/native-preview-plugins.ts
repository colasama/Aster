import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface PreviewGeneratorReference {
  pluginId: string;
  nodeType: string;
}
export interface UnavailablePreviewGenerator extends PreviewGeneratorReference {
  reason: "safe-mode" | "disabled" | "missing";
}
interface PluginPackage extends PreviewGeneratorReference {
  manifestToml: string;
  shaderSources: Record<string, string>;
}
export type ResolvePreviewPlugins = (references: PreviewGeneratorReference[]) => Promise<unknown>;

const identity = (value: PreviewGeneratorReference) =>
  JSON.stringify([value.pluginId, value.nodeType]);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function referencesFrom(document: {
  compositions?: Array<{ layers: Array<{ kind: string; generator?: PreviewGeneratorReference }> }>;
}): PreviewGeneratorReference[] {
  const references = new Map<string, PreviewGeneratorReference>();
  for (const composition of document.compositions ?? []) {
    for (const layer of composition.layers ?? []) {
      if (layer.kind !== "generator" || !layer.generator) continue;
      const { pluginId, nodeType } = layer.generator;
      if (typeof pluginId !== "string" || typeof nodeType !== "string")
        throw new Error("Invalid preview generator reference");
      if (pluginId.startsWith("org.aster.builtin.")) continue;
      if (!pluginId || pluginId.length > 128 || !nodeType || nodeType.length > 256)
        throw new Error("Invalid preview generator identity");
      references.set(identity({ pluginId, nodeType }), { pluginId, nodeType });
      if (references.size > 256) throw new Error("Preview generator reference budget exceeded");
    }
  }
  return [...references].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, value]) => value);
}

async function ownedDirectory(path: string): Promise<void> {
  await mkdir(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink())
    throw new Error("Preview plugin store is not an owned directory");
}

async function frozenFile(path: string, source: string): Promise<void> {
  try {
    await writeFile(path, source, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size !== Buffer.byteLength(source))
      throw new Error("Frozen preview plugin file changed");
    if ((await readFile(path, "utf8")) !== source)
      throw new Error("Frozen preview plugin contents changed");
  }
}

function shaderParts(path: string): string[] {
  const parts = path.split(/[\\/]/);
  if (
    !path.endsWith(".wgsl") ||
    path.length > 4096 ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.includes(":") ||
        [...part].some((character) => character.charCodeAt(0) < 32) ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  )
    throw new Error("Preview plugin shader path is not portable and relative");
  return parts;
}

/** Only the trusted bridge supplies executable content; the renderer supplies project identities. */
export async function freezePreviewPlugins(
  directory: string,
  document: Parameters<typeof referencesFrom>[0],
  resolve?: ResolvePreviewPlugins,
): Promise<{
  plugins: string[];
  unavailableGenerators: UnavailablePreviewGenerator[];
  identity?: string;
}> {
  const references = referencesFrom(document);
  if (!references.length) return { plugins: [], unavailableGenerators: [] };
  if (!resolve) throw new Error("Trusted preview plugin service is unavailable");
  const snapshot = (await resolve(references)) as {
    packages?: PluginPackage[];
    unavailable?: UnavailablePreviewGenerator[];
  };
  if (
    !snapshot ||
    !Array.isArray(snapshot.packages) ||
    !Array.isArray(snapshot.unavailable) ||
    snapshot.packages.length + snapshot.unavailable.length !== references.length
  )
    throw new Error("Incomplete preview plugin admission");
  const pending = new Set(references.map(identity));
  const packages: PluginPackage[] = [];
  const unavailable: UnavailablePreviewGenerator[] = [];
  let bytes = 0;
  for (const item of snapshot.packages) {
    if (
      !item ||
      !pending.delete(identity(item)) ||
      typeof item.manifestToml !== "string" ||
      Buffer.byteLength(item.manifestToml) > 1048576 ||
      !item.shaderSources ||
      typeof item.shaderSources !== "object" ||
      Array.isArray(item.shaderSources)
    )
      throw new Error("Invalid admitted preview plugin package");
    const shaders = Object.entries(item.shaderSources).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    if (!shaders.length || shaders.length > 32) throw new Error("Preview shader count exceeded");
    const paths = new Set<string>();
    let shaderBytes = 0;
    for (const [path, source] of shaders) {
      const canonical = shaderParts(path).join("/").toLowerCase();
      if (paths.has(canonical) || typeof source !== "string" || Buffer.byteLength(source) > 4194304)
        throw new Error("Invalid preview shader contents or alias");
      paths.add(canonical);
      shaderBytes += Buffer.byteLength(source);
    }
    bytes += Buffer.byteLength(item.manifestToml) + shaderBytes;
    if (shaderBytes > 16777216 || bytes > 67108864)
      throw new Error("Preview plugin byte budget exceeded");
    packages.push({
      pluginId: item.pluginId,
      nodeType: item.nodeType,
      manifestToml: item.manifestToml,
      shaderSources: Object.fromEntries(shaders),
    });
  }
  for (const item of snapshot.unavailable) {
    if (
      !item ||
      !pending.delete(identity(item)) ||
      !["safe-mode", "disabled", "missing"].includes(item.reason)
    )
      throw new Error("Invalid unavailable preview generator");
    unavailable.push({ pluginId: item.pluginId, nodeType: item.nodeType, reason: item.reason });
  }
  if (pending.size) throw new Error("Preview plugin references were not classified");
  const order = (a: PreviewGeneratorReference, b: PreviewGeneratorReference) =>
    identity(a) < identity(b) ? -1 : identity(a) > identity(b) ? 1 : 0;
  packages.sort(order);
  unavailable.sort(order);
  const plugins: string[] = [];
  for (const item of packages) {
    const root = join(directory, `plugin-${digest(JSON.stringify(item))}`);
    await ownedDirectory(root);
    for (const [path, source] of Object.entries(item.shaderSources)) {
      const parts = shaderParts(path);
      let parent = root;
      for (const part of parts.slice(0, -1)) {
        parent = join(parent, part);
        await ownedDirectory(parent);
      }
      await frozenFile(join(root, ...parts), source);
    }
    const manifest = join(root, "plugin.toml");
    await frozenFile(manifest, item.manifestToml);
    plugins.push(manifest);
  }
  return {
    plugins,
    unavailableGenerators: unavailable,
    identity: digest(JSON.stringify({ packages, unavailable })),
  };
}

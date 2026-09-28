import registryDocument from "../../schemas/ai-commands.v1.json";
import { didYouMean } from "./suggestions";

export type CommandRisk = "reversible" | "external" | "destructive";

export interface JsonSchema {
  [key: string]: unknown;
}

export interface CommandDescriptor {
  name: string;
  version: number;
  category: string;
  description: string;
  inputSchema: JsonSchema;
  requiredPermissions: string[];
  risk: CommandRisk;
  undoable: boolean;
  previewable: boolean;
}

interface CommandRegistryDocument {
  schemaVersion: number;
  $defs?: Record<string, JsonSchema>;
  commands: CommandDescriptor[];
}

const parsedRegistry = registryDocument as CommandRegistryDocument;

if (parsedRegistry.schemaVersion !== 1) throw new Error("Unsupported Aster AI command schema");

const descriptorByName = new Map(
  parsedRegistry.commands.map((descriptor) => {
    const resolved = Object.freeze({
      ...descriptor,
      inputSchema: resolveSchemaReferences(descriptor.inputSchema, parsedRegistry.$defs ?? {}),
    });
    return [resolved.name, resolved] as const;
  }),
);

if (descriptorByName.size !== parsedRegistry.commands.length)
  throw new Error("Aster AI command registry contains duplicate command names");

export const AI_COMMAND_SCHEMA_VERSION = parsedRegistry.schemaVersion;
export const AI_COMMAND_DESCRIPTORS = Object.freeze([...descriptorByName.values()]);
export const AI_COMMAND_TYPES = Object.freeze(AI_COMMAND_DESCRIPTORS.map(({ name }) => name));

export function getCommandDescriptors(names: readonly string[]): CommandDescriptor[] {
  return names.map((name) => {
    const descriptor = descriptorByName.get(name);
    if (!descriptor)
      throw new Error(
        `Unknown Aster command: ${name}.${didYouMean(name, descriptorByName.keys()) || " Use search_capabilities to find commands."}`,
      );
    return descriptor;
  });
}

const STOP_WORDS = new Set(["a", "an", "the", "of", "to", "on", "in", "for", "and", "or", "with"]);

/** Agent vocabulary mapped onto the words used by command names and descriptions. */
const SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  delete: ["remove"],
  erase: ["remove"],
  drop: ["remove"],
  destroy: ["remove"],
  clear: ["remove", "cleanup"],
  garbage: ["cleanup", "orphan", "remove"],
  unused: ["orphan", "cleanup"],
  create: ["add"],
  new: ["add"],
  insert: ["add"],
  make: ["add"],
  footage: ["source"],
  media: ["source"],
  asset: ["source"],
  assets: ["source"],
  clip: ["source", "layer"],
  video: ["source", "layer", "time"],
  file: ["source"],
  image: ["source", "layer"],
  replace: ["relink", "set", "reload", "source"],
  swap: ["set", "relink", "source"],
  change: ["set"],
  update: ["set"],
  edit: ["set"],
  comp: ["composition"],
  precomp: ["precompose", "composition"],
  nested: ["precompose", "composition"],
  nest: ["precompose"],
  group: ["precompose", "folder"],
  lyric: ["text", "typography", "animator"],
  lyrics: ["text", "typography", "animator"],
  caption: ["text"],
  subtitle: ["text"],
  title: ["text"],
  character: ["text", "animator"],
  char: ["text", "animator"],
  letter: ["text", "animator"],
  glyph: ["text", "animator"],
  font: ["text", "style", "font"],
  animate: ["keyframe", "animator", "expression"],
  animation: ["keyframe", "animator", "expression"],
  key: ["keyframe"],
  ease: ["easing", "keyframe"],
  timing: ["time", "timing"],
  offset: ["time", "mapping"],
  trim: ["timing"],
  speed: ["stretch", "time", "remap"],
  retime: ["remap", "time"],
  filter: ["effect"],
  fx: ["effect"],
  blur: ["effect"],
  glow: ["effect"],
  colour: ["color"],
  tint: ["color"],
  sound: ["audio"],
  volume: ["audio", "gain"],
  mute: ["audio", "toggle"],
  hide: ["toggle"],
  show: ["toggle"],
  visible: ["toggle"],
  visibility: ["toggle"],
  enable: ["toggle"],
  disable: ["toggle"],
  move: ["reorder", "move", "position"],
  order: ["reorder"],
  parent: ["parent"],
  link: ["parent", "relink"],
  rename: ["rename"],
  name: ["rename"],
  work: ["workarea"],
  area: ["workarea"],
  range: ["workarea"],
  size: ["settings"],
  resolution: ["settings"],
  fps: ["settings"],
  duration: ["settings", "timing"],
  light: ["light"],
  lighting: ["light"],
  material: ["material"],
  path: ["shape", "graph"],
  mask: ["mask"],
  particle: ["generator"],
  particles: ["generator"],
  duplicate: ["duplicate", "cloner"],
  copy: ["duplicate"],
  clone: ["duplicate", "cloner"],
};

const descriptorTokens = new Map(
  AI_COMMAND_DESCRIPTORS.map((descriptor) => [
    descriptor.name,
    {
      name: new Set(tokens(descriptor.name)),
      category: new Set(tokens(descriptor.category)),
      description: new Set(tokens(descriptor.description)),
    },
  ]),
);

/** Ranks commands by matched intent terms, so partial or paraphrased queries still find commands. */
export function searchCommandDescriptors(
  query: string,
  category?: string,
  limit = 12,
): CommandDescriptor[] {
  const bounded = Math.max(1, Math.min(24, Math.floor(limit)));
  const terms = [...new Set(tokens(query))];
  const candidates = AI_COMMAND_DESCRIPTORS.filter(
    (descriptor) => !category || descriptor.category === category,
  );
  if (terms.length === 0) return candidates.slice(0, bounded);
  const exact = candidates.find(
    (descriptor) => descriptor.name.toLocaleLowerCase() === query.trim().toLocaleLowerCase(),
  );
  const scored = candidates
    .map((descriptor, index) => {
      const fields = descriptorTokens.get(descriptor.name);
      let score = 0;
      let matched = 0;
      for (const term of terms) {
        const variants = [term, ...(SYNONYMS[term] ?? [])];
        let best = 0;
        for (const [variantIndex, variant] of variants.entries()) {
          const weight = variantIndex === 0 ? 1 : 0.8;
          if (fields?.name.has(variant)) best = Math.max(best, 3 * weight);
          else if (fields?.category.has(variant)) best = Math.max(best, 2 * weight);
          else if (fields?.description.has(variant)) best = Math.max(best, 1 * weight);
        }
        if (best > 0) matched++;
        score += best;
      }
      if (descriptor === exact) score += 100;
      return { descriptor, score: score + matched * 2, matched, index };
    })
    .filter((entry) => entry.matched > 0);
  const strongest = Math.max(0, ...scored.map((entry) => entry.matched));
  return scored
    .filter((entry) => entry.matched >= Math.min(strongest, Math.ceil(terms.length / 2)))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, bounded)
    .map((entry) => entry.descriptor);
}

/** Compact name-only catalog grouped by category (about 2 KiB). */
export function commandIndex(category?: string): Record<string, string[]> {
  const index: Record<string, string[]> = {};
  for (const descriptor of AI_COMMAND_DESCRIPTORS) {
    if (category && descriptor.category !== category) continue;
    index[descriptor.category] ??= [];
    index[descriptor.category].push(descriptor.name);
  }
  return index;
}

function tokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLocaleLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token && !STOP_WORDS.has(token))
    .flatMap((token) => {
      const stem = stemToken(token);
      return stem === token ? [token] : [token, stem];
    });
}

function stemToken(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

function resolveSchemaReferences(
  schema: JsonSchema,
  definitions: Record<string, JsonSchema>,
  resolving = new Set<string>(),
): JsonSchema {
  if (typeof schema.$ref === "string") {
    const prefix = "#/$defs/";
    if (!schema.$ref.startsWith(prefix)) throw new Error(`Unsupported schema ref: ${schema.$ref}`);
    const name = schema.$ref.slice(prefix.length);
    const definition = definitions[name];
    if (!definition) throw new Error(`Missing schema definition: ${name}`);
    if (resolving.has(name)) throw new Error(`Recursive schema definition is unsupported: ${name}`);
    return resolveSchemaReferences(definition, definitions, new Set(resolving).add(name));
  }
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [
      key,
      Array.isArray(value)
        ? value.map((entry) =>
            isSchemaObject(entry)
              ? resolveSchemaReferences(entry, definitions, new Set(resolving))
              : entry,
          )
        : isSchemaObject(value)
          ? resolveSchemaReferences(value, definitions, new Set(resolving))
          : value,
    ]),
  );
}

function isSchemaObject(value: unknown): value is JsonSchema {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

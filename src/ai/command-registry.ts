import registryDocument from "../../schemas/ai-commands.v1.json";

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
    if (!descriptor) throw new Error(`Unknown Aster command: ${name}`);
    return descriptor;
  });
}

export function searchCommandDescriptors(
  query: string,
  category?: string,
  limit = 12,
): CommandDescriptor[] {
  const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  return AI_COMMAND_DESCRIPTORS.filter((descriptor) => {
    if (category && descriptor.category !== category) return false;
    const searchable =
      `${descriptor.name} ${descriptor.category} ${descriptor.description}`.toLocaleLowerCase();
    return terms.every((term) => searchable.includes(term));
  }).slice(0, Math.max(1, Math.min(24, Math.floor(limit))));
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

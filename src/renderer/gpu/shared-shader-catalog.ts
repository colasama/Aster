import manifest from "../../../shaders/manifest.json";

type ShaderOverride = { type: "u32"; default: number };
type ShaderProgram = { source: string; overrides: Map<string, ShaderOverride> };

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validU32(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

function onlyFields(value: Record<string, unknown>, fields: string[]): boolean {
  return Object.keys(value).every((key) => fields.includes(key));
}

/** The manifest owns fragment order; source files retain their own whitespace and declarations. */
export class SharedShaderCatalog {
  readonly #programs = new Map<string, ShaderProgram>();

  constructor(document: unknown, sources: Readonly<Record<string, string>>) {
    if (
      !object(document) ||
      !onlyFields(document, ["schema_version", "constants", "fragments", "programs"]) ||
      document.schema_version !== 1 ||
      !object(document.fragments) ||
      Object.keys(document.fragments).length === 0 ||
      !object(document.programs)
    )
      throw new Error("Invalid shared shader manifest");
    const declarations = document.constants === undefined ? {} : document.constants;
    if (!object(declarations)) throw new Error("Invalid shared shader constants");
    const constants = new Map<string, number>();
    for (const [name, value] of Object.entries(declarations)) {
      if (name.length === 0 || !validU32(value))
        throw new Error(`Invalid shared shader constant: ${name}`);
      constants.set(name, value);
    }
    const fragments = new Map<string, string>();
    const sourcePaths = new Set(Object.keys(sources));
    for (const [id, path] of Object.entries(document.fragments)) {
      if (
        id.length === 0 ||
        typeof path !== "string" ||
        !path.endsWith(".wgsl") ||
        /[\\:]/.test(path) ||
        path.split("/").some((part) => part === "" || part === "." || part === "..") ||
        !sourcePaths.has(path) ||
        typeof sources[path] !== "string"
      )
        throw new Error(`Missing or invalid shared shader fragment: ${id}`);
      fragments.set(id, sources[path]);
    }
    const declaredPaths = new Set(Object.values(document.fragments));
    for (const path of sourcePaths) {
      if (!declaredPaths.has(path)) throw new Error(`Undeclared shared shader source: ${path}`);
    }
    const usedFragments = new Set<string>();
    const usedConstants = new Set<string>();
    for (const [id, value] of Object.entries(document.programs)) {
      if (
        id.length === 0 ||
        !object(value) ||
        !onlyFields(value, ["fragments", "entry_points", "overrides"]) ||
        !Array.isArray(value.fragments) ||
        value.fragments.length === 0 ||
        !Array.isArray(value.entry_points) ||
        !object(value.overrides)
      )
        throw new Error(`Invalid shared shader program: ${id}`);
      const entries = new Set<string>();
      for (const entry of value.entry_points) {
        if (
          !object(entry) ||
          !onlyFields(entry, ["name", "stage"]) ||
          typeof entry.name !== "string" ||
          entry.name.length === 0 ||
          entries.has(entry.name) ||
          typeof entry.stage !== "string" ||
          !["vertex", "fragment", "compute"].includes(entry.stage)
        )
          throw new Error(`Invalid shared shader entry point: ${id}`);
        entries.add(entry.name);
      }
      const definitions = new Map<string, ShaderOverride>();
      for (const [name, definition] of Object.entries(value.overrides)) {
        if (
          name.length === 0 ||
          !object(definition) ||
          !onlyFields(definition, ["type", "default"]) ||
          definition.type !== "u32" ||
          !validU32(definition.default)
        )
          throw new Error(`Invalid shared shader override: ${id}.${name}`);
        definitions.set(name, { type: "u32", default: definition.default });
      }
      const source = value.fragments
        .map((fragment) => {
          if (typeof fragment !== "string") {
            if (
              !object(fragment) ||
              !onlyFields(fragment, ["constant"]) ||
              typeof fragment.constant !== "string"
            )
              throw new Error(`Invalid shared shader recipe item: ${id}`);
            const value = constants.get(fragment.constant);
            if (value === undefined)
              throw new Error(`Unknown shared shader constant: ${fragment.constant}`);
            usedConstants.add(fragment.constant);
            return String(value);
          }
          const text = fragments.get(fragment);
          if (text === undefined) throw new Error(`Unknown shared shader fragment: ${fragment}`);
          usedFragments.add(fragment);
          return text;
        })
        .join("");
      this.#programs.set(id, { source, overrides: definitions });
    }
    if (this.#programs.size === 0) throw new Error("Shared shader manifest has no programs");
    for (const fragment of fragments.keys()) {
      if (!usedFragments.has(fragment))
        throw new Error(`Unused shared shader fragment: ${fragment}`);
    }
    for (const name of constants.keys()) {
      if (!usedConstants.has(name)) throw new Error(`Unused shared shader constant: ${name}`);
    }
  }

  source(id: string): string {
    const program = this.#programs.get(id);
    if (!program) throw new Error(`Unknown shared shader program: ${id}`);
    return program.source;
  }

  pipelineConstants(id: string, supplied: Readonly<Record<string, number>> = {}) {
    const program = this.#programs.get(id);
    if (!program) throw new Error(`Unknown shared shader program: ${id}`);
    const values = new Map([...program.overrides].map(([name, value]) => [name, value.default]));
    for (const [name, value] of Object.entries(supplied)) {
      if (!program.overrides.has(name) || !validU32(value))
        throw new Error(`Invalid shared shader pipeline constant: ${id}.${name}`);
      values.set(name, value);
    }
    return Object.fromEntries(values);
  }
}

const files = import.meta.glob<string>("../../../shaders/**/*.wgsl", {
  eager: true,
  query: "?raw",
  import: "default",
});
const sources = Object.fromEntries(
  Object.entries(files).map(([path, source]) => [path.slice("../../../shaders/".length), source]),
);
export const sharedShaders = new SharedShaderCatalog(manifest, sources);

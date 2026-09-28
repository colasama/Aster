import variant from "@jitl/quickjs-singlefile-browser-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSContext,
} from "quickjs-emscripten-core";
import { activeComposition } from "../core/project/project";
import type { Composition, Layer, Project } from "../core/types";
import { AiCommandBatch, layerSourceRange } from "./command-normalizer";
import { EDIT_LIMITS, EditError, encodedBytes, limitExceeded } from "./edit-limits";
import type { EditProgress, EditTask, EditTaskResult } from "./edit-task";
import { SCRIPT_API } from "./script-api";

const SCRIPT_FILE = "aster-script.js";
/** User code starts on the second line of the evaluated wrapper. */
const SCRIPT_LINE_OFFSET = 1;

/** No host objects enter the VM. All crossings are bounded JSON and typed commands. */
export async function executeScript(
  task: EditTask & { code: string },
  progress: (value: EditProgress) => void = () => {},
  timeoutMs: number = EDIT_LIMITS.executionMs,
): Promise<EditTaskResult> {
  if (encodedBytes(task.code) > EDIT_LIMITS.scriptBytes)
    limitExceeded("scriptBytes", encodedBytes(task.code), EDIT_LIMITS.scriptBytes);
  const module = await newQuickJSWASMModuleFromVariant(
    newVariant(variant, { wasmMemory: new WebAssembly.Memory({ initial: 256, maximum: 1024 }) }),
  );
  const vm = module.newContext();
  const deadline = Date.now() + timeoutMs;
  vm.runtime.setMemoryLimit(32 * 1024 * 1024);
  vm.runtime.setMaxStackSize(512 * 1024);
  vm.runtime.setInterruptHandler(() => Date.now() >= deadline);
  const batch = new AiCommandBatch(task.project, task.currentTime, task.maxOperations);
  const modules = task.modules ?? {};
  let fatal: unknown;
  let lastProgress = 0;
  const install = (name: string, callback: (input: Record<string, unknown>) => unknown) => {
    const handle = vm.newFunction(name, (argument) => {
      try {
        if (fatal) throw fatal;
        const input: unknown = JSON.parse(vm.getString(argument));
        if (!input || typeof input !== "object" || Array.isArray(input))
          throw new Error("Bridge input must be an object");
        const output = callback(input as Record<string, unknown>);
        if (encodedBytes(output) > EDIT_LIMITS.queryBytes)
          limitExceeded("queryBytes", encodedBytes(output), EDIT_LIMITS.queryBytes);
        return vm.newString(JSON.stringify(output ?? null));
      } catch (error) {
        fatal = error;
        return { error: vm.newError(error instanceof Error ? error.message : String(error)) };
      }
    });
    vm.setProp(vm.global, name, handle);
    handle.dispose();
  };
  try {
    install("__asterCommand", ({ command, compositionId }) => {
      if (compositionId !== undefined && compositionId !== batch.project.activeCompositionId)
        batch.append({ type: "setActiveComposition", compositionId });
      const warningsBefore = batch.warnings.length;
      const operation = batch.append(command);
      const warnings = batch.warnings.slice(warningsBefore);
      return { ...commandReference(operation), ...(warnings.length ? { warnings } : {}) };
    });
    install("__asterQuery", ({ kind, compositionId, id, options }) =>
      scriptQuery(batch, {
        kind: String(kind),
        compositionId: typeof compositionId === "string" ? compositionId : undefined,
        id: typeof id === "string" ? id : undefined,
        options: isRecord(options) ? options : {},
        deadline,
      }),
    );
    install("__asterProgress", ({ fraction, message }) => {
      if (
        typeof fraction !== "number" ||
        !Number.isFinite(fraction) ||
        fraction < 0 ||
        fraction > 1 ||
        typeof message !== "string" ||
        message.length > 200
      )
        throw new Error("Invalid progress value");
      if (Date.now() - lastProgress >= 50) {
        progress({ fraction, message, operations: batch.operations.length });
        lastProgress = Date.now();
      }
      return null;
    });
    installModuleLoader(vm, modules, (error) => {
      fatal = error;
    });
    const api = vm.evalCode(SCRIPT_API, "aster-api.js");
    if (api.error) {
      api.error.dispose();
      throw new Error("Aster script API failed to initialize");
    }
    api.value.dispose();
    const evaluated = vm.evalCode(
      `(() => { const serialize = JSON.stringify; const value = (() => { "use strict";\n${task.code}\n})(); if (value && typeof value.then === "function") throw new Error("Scripts must return synchronously; Promises and imports are unsupported"); return serialize(value) ?? "null"; })()`,
      SCRIPT_FILE,
    );
    if (evaluated.error) {
      const error = vm.dump(evaluated.error) as {
        message?: string;
        stack?: string;
        lineNumber?: number;
      };
      evaluated.error.dispose();
      const location = scriptLocation(error);
      if (fatal) throw withLocation(fatal, location);
      const timedOut = Date.now() >= deadline;
      throw new EditError(
        timedOut ? "execution_timeout" : "script_failed",
        `${error?.message ?? "Script execution failed"}${location ? ` (${location.label})` : ""}`,
        location ? { line: location.line, column: location.column, stack: location.stack } : {},
      );
    }
    let result: unknown;
    try {
      if (fatal) throw fatal;
      const json = vm.getString(evaluated.value);
      if (encodedBytes(json) > EDIT_LIMITS.resultBytes)
        limitExceeded("resultBytes", encodedBytes(json), EDIT_LIMITS.resultBytes);
      result = JSON.parse(json);
    } finally {
      evaluated.value.dispose();
    }
    return { ...batch.finish(), result };
  } finally {
    vm.dispose();
  }
}

function installModuleLoader(
  vm: QuickJSContext,
  modules: Readonly<Record<string, string>>,
  fail: (error: unknown) => void,
) {
  const handle = vm.newFunction("__asterRequire", (argument) => {
    const name = vm.getString(argument);
    const source = new Map(Object.entries(modules)).get(name);
    if (source === undefined) {
      const error = new EditError(
        "module_not_found",
        `Script module does not exist: ${name}. Store it with put_script_module; available: ${Object.keys(modules).join(", ") || "none"}`,
      );
      fail(error);
      return { error: vm.newError(error.message) };
    }
    const factory = vm.evalCode(
      `(function (module, exports, aster) {\n${source}\n})`,
      `module:${name.slice(0, 64)}`,
    );
    return factory.error ? { error: factory.error } : factory.value;
  });
  vm.setProp(vm.global, "__asterRequire", handle);
  handle.dispose();
}

function commandReference(operation: ReturnType<AiCommandBatch["append"]>) {
  if (operation.type === "addLayer") return { type: operation.type, id: operation.layer.id };
  if (operation.type === "addEffect") return { type: operation.type, id: operation.effect.id };
  if (operation.type === "addComposition")
    return { type: operation.type, id: operation.composition.id };
  if (operation.type === "addSource") return { type: operation.type, id: operation.source.id };
  if (operation.type === "addProjectFolder")
    return { type: operation.type, id: operation.folder.id };
  if (operation.type === "precomposeLayers")
    return {
      type: operation.type,
      id: operation.nestedComposition.id,
      compositionId: operation.nestedComposition.id,
      wrapperLayerId: operation.wrapper.id,
    };
  return { type: operation.type };
}

function scriptQuery(
  batch: AiCommandBatch,
  input: {
    kind: string;
    compositionId?: string;
    id?: string;
    options: Record<string, unknown>;
    deadline: number;
  },
): unknown {
  const { kind, options } = input;
  const project = batch.project;
  if (kind === "active") return compositionMetadata(project, activeComposition(project));
  if (kind === "compositions")
    return filterByName(project.compositions, options).map((c) => compositionMetadata(project, c));
  if (kind === "budget")
    return {
      operations: {
        used: batch.operations.length,
        limit: batch.maxOperations,
        remaining: Math.max(0, batch.maxOperations - batch.operations.length),
      },
      queryBytesPerCall: EDIT_LIMITS.queryBytes,
      resultBytes: EDIT_LIMITS.resultBytes,
      timeRemainingMs: Math.max(0, input.deadline - Date.now()),
    };
  if (kind === "warnings") return batch.warnings;
  const composition = project.compositions.find((c) => c.id === input.compositionId);
  if (!composition) throw new Error(`Unknown composition: ${String(input.compositionId)}`);
  if (kind === "composition") return compositionMetadata(project, composition);
  if (kind === "layers")
    return filterByName(
      composition.layers.filter(
        (layer) => options.kind === undefined || layer.kind === options.kind,
      ),
      options,
    ).map((layer) => ({
      id: layer.id,
      name: layer.name,
      kind: layer.kind,
      inPoint: layer.inPoint,
      outPoint: layer.outPoint,
      ...(layer.sourceCompositionId ? { sourceCompositionId: layer.sourceCompositionId } : {}),
    }));
  if (kind === "layer") {
    const layer = composition.layers.find((l) => l.id === input.id);
    if (!layer)
      throw new Error(
        `Unknown layer ${String(input.id)} in composition "${composition.name}" (${composition.id})`,
      );
    const data = { ...layer, sourceRange: layerSourceRange(project, layer) };
    return Array.isArray(options.fields) ? pickFields(data, options.fields) : data;
  }
  throw new Error(`Unknown script query: ${kind}`);
}

function compositionMetadata(project: Project, c: Composition) {
  return {
    id: c.id,
    name: c.name,
    width: c.width,
    height: c.height,
    duration: c.duration,
    frameRate: c.frameRate,
    layerCount: c.layers.length,
    active: project.activeCompositionId === c.id,
  };
}

function filterByName<T extends { name: string }>(
  values: readonly T[],
  options: Record<string, unknown>,
): T[] {
  const name = typeof options.name === "string" ? options.name : undefined;
  const prefix = typeof options.namePrefix === "string" ? options.namePrefix : undefined;
  const limit =
    typeof options.limit === "number" && Number.isSafeInteger(options.limit) && options.limit > 0
      ? options.limit
      : Number.POSITIVE_INFINITY;
  const matches: T[] = [];
  for (const value of values) {
    if (name !== undefined && value.name !== name) continue;
    if (prefix !== undefined && !value.name.startsWith(prefix)) continue;
    matches.push(value);
    if (matches.length >= limit) break;
  }
  return matches;
}

function pickFields(value: Layer & Record<string, unknown>, fields: readonly unknown[]) {
  const picked: Record<string, unknown> = {};
  for (const field of fields.slice(0, 64)) {
    if (typeof field !== "string" || !field) throw new Error("inspect fields must be strings");
    let current: unknown = value;
    for (const key of field.split("."))
      current =
        current && typeof current === "object"
          ? (current as Record<string, unknown>)[key]
          : undefined;
    picked[field] = current ?? null;
  }
  return picked;
}

interface ScriptLocation {
  line: number;
  column: number;
  label: string;
  stack: string;
}

function scriptLocation(error: { stack?: string; lineNumber?: number } | undefined) {
  const stack = typeof error?.stack === "string" ? error.stack : "";
  const frames = stack
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 6);
  const pattern = new RegExp(`${SCRIPT_FILE.replace(".", "\\.")}:(\\d+):(\\d+)`);
  for (const frame of frames) {
    const match = pattern.exec(frame);
    if (match) return location(Number(match[1]) - SCRIPT_LINE_OFFSET, Number(match[2]), frames, "");
    const module = /module:([^:)]+):(\d+):(\d+)/.exec(frame);
    if (module)
      return location(Number(module[2]) - 1, Number(module[3]), frames, `module ${module[1]} `);
  }
  if (typeof error?.lineNumber === "number")
    return location(error.lineNumber - SCRIPT_LINE_OFFSET, 0, frames, "");
  return undefined;
}

function location(line: number, column: number, frames: string[], prefix: string) {
  const bounded = Math.max(1, line);
  return {
    line: bounded,
    column,
    label: `${prefix}line ${bounded}${column ? `:${column}` : ""}`,
    stack: frames.join("\n"),
  } satisfies ScriptLocation;
}

function withLocation(error: unknown, location: ScriptLocation | undefined): unknown {
  if (!location) return error;
  if (error instanceof EditError)
    return new EditError(error.code, `${error.message} (${location.label})`, {
      ...error.details,
      line: location.line,
      column: location.column,
    });
  if (error instanceof Error)
    return new EditError("script_failed", `${error.message} (${location.label})`, {
      line: location.line,
      column: location.column,
    });
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

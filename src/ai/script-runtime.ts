import variant from "@jitl/quickjs-singlefile-browser-release-sync";
import { newQuickJSWASMModuleFromVariant, newVariant } from "quickjs-emscripten-core";
import { activeComposition } from "../core/project/project";
import { AiCommandBatch } from "./command-normalizer";
import { EDIT_LIMITS, EditError, encodedBytes, limitExceeded } from "./edit-limits";
import type { EditProgress, EditTask, EditTaskResult } from "./edit-task";
import { SCRIPT_API } from "./script-api";

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
        if (encodedBytes(output) > EDIT_LIMITS.resultBytes)
          limitExceeded("queryBytes", encodedBytes(output), EDIT_LIMITS.resultBytes);
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
      const operation = batch.append(command);
      if (operation.type === "addLayer") return { id: operation.layer.id };
      if (operation.type === "addEffect") return { id: operation.effect.id };
      if (operation.type === "addComposition") return { id: operation.composition.id };
      return { type: operation.type };
    });
    install("__asterQuery", ({ kind, compositionId, id }) => {
      const metadata = (c: (typeof batch.project.compositions)[number]) => ({
        id: c.id,
        name: c.name,
        width: c.width,
        height: c.height,
        duration: c.duration,
        frameRate: c.frameRate,
      });
      if (kind === "active") return metadata(activeComposition(batch.project));
      if (kind === "compositions") return batch.project.compositions.map(metadata);
      const c = batch.project.compositions.find((c) => c.id === compositionId);
      if (!c) throw new Error("Unknown composition");
      if (kind === "composition") return metadata(c);
      if (kind === "layers") return c.layers.map(({ id, name, kind }) => ({ id, name, kind }));
      if (kind === "layer") {
        const layer = c.layers.find((l) => l.id === id);
        if (!layer) throw new Error("Unknown layer");
        return layer;
      }
      throw new Error("Unknown script query");
    });
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
    const evaluated = vm.evalCode(
      `${SCRIPT_API}\n(() => { const serialize = JSON.stringify; const value = (() => { "use strict";\n${task.code}\n})(); if (value && typeof value.then === "function") throw new Error("Scripts must return synchronously; Promises and imports are unsupported"); return serialize(value) ?? "null"; })()`,
      "aster-script.js",
    );
    if (evaluated.error) {
      const error = vm.dump(evaluated.error) as { message?: string };
      evaluated.error.dispose();
      if (fatal) throw fatal;
      throw new EditError(
        Date.now() >= deadline ? "execution_timeout" : "script_failed",
        error?.message ?? "Script execution failed",
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

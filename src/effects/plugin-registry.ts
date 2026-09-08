import {
  HOST_PLUGIN_API_VERSION,
  type PluginManifest,
  type PluginParameter,
  type PluginStatus,
} from "../core/plugins/plugins";
import { replacePluginEffectDefinitions } from "./registry";
import type { EffectDefinition, EffectParameterDefinition } from "./types";

type Listener = () => void;

const listeners = new Set<Listener>();
let installedDefinitions: readonly EffectDefinition[] = [];

export function getPluginEffectDefinitions(): readonly EffectDefinition[] {
  return installedDefinitions;
}

export function subscribePluginEffectDefinitions(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function synchronizePluginEffectDefinitions(status: PluginStatus): readonly Error[] {
  const failures: Error[] = [];
  const definitions: EffectDefinition[] = [];
  const pluginIds = new Set<string>();
  if (!status.safeMode) {
    for (const manifest of status.report.plugins) {
      if (status.disabled.includes(manifest.plugin.id)) continue;
      if (manifest.plugin.kind === "scene_generator") continue;
      try {
        if (pluginIds.has(manifest.plugin.id))
          throw new Error(`Plugin id ${manifest.plugin.id} is installed more than once`);
        definitions.push(pluginManifestToEffectDefinition(manifest));
        pluginIds.add(manifest.plugin.id);
      } catch (reason) {
        failures.push(reason instanceof Error ? reason : new Error("Invalid plugin manifest"));
      }
    }
  }
  installedDefinitions = definitions;
  replacePluginEffectDefinitions(definitions);
  for (const listener of listeners) listener();
  return failures;
}

export function pluginManifestToEffectDefinition(manifest: PluginManifest): EffectDefinition {
  assertNonEmpty(manifest.plugin.id, "plugin id");
  if (!isValidPluginId(manifest.plugin.id))
    throw new Error(`Plugin id ${manifest.plugin.id} must be a reverse-domain identifier`);
  assertNonEmpty(manifest.plugin.name, "plugin name");
  if (manifest.plugin.api_version !== HOST_PLUGIN_API_VERSION)
    throw new Error(
      `Plugin ${manifest.plugin.id} uses unsupported API ${manifest.plugin.api_version}`,
    );
  const names = new Set<string>();
  const parameters = manifest.parameters.map((parameter) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(parameter.name))
      throw new Error(`Plugin ${manifest.plugin.id} has invalid parameter name ${parameter.name}`);
    if (names.has(parameter.name))
      throw new Error(`Plugin ${manifest.plugin.id} repeats parameter ${parameter.name}`);
    names.add(parameter.name);
    return pluginParameterToEffectParameter(parameter);
  });
  return {
    type: manifest.plugin.id,
    name: manifest.plugin.name,
    category: "Plugins",
    description: `GPU effect plugin · ${manifest.plugin.id} · v${manifest.plugin.version}`,
    execution: "fused-pixel",
    parameters,
  };
}

function isValidPluginId(id: string): boolean {
  const labels = id.split(".");
  return (
    id.length <= 128 &&
    labels.length >= 2 &&
    labels.every(
      (label) =>
        label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  );
}

export function pluginParameterToEffectParameter(
  parameter: PluginParameter,
): EffectParameterDefinition {
  assertNonEmpty(parameter.name, "parameter name");
  assertNonEmpty(parameter.label, `label for ${parameter.name}`);
  switch (parameter.type) {
    case "number": {
      assertFinite(parameter.default, `${parameter.name} default`);
      assertFinite(parameter.min, `${parameter.name} minimum`);
      assertFinite(parameter.max, `${parameter.name} maximum`);
      if (
        parameter.min > parameter.max ||
        parameter.default < parameter.min ||
        parameter.default > parameter.max
      )
        throw new Error(`Plugin number parameter ${parameter.name} has an invalid range`);
      return {
        key: parameter.name,
        label: parameter.label,
        kind: "number",
        defaultValue: parameter.default,
        min: parameter.min,
        max: parameter.max,
        step: numberStep(parameter.min, parameter.max),
      };
    }
    case "color":
      if (
        parameter.default.length !== 4 ||
        parameter.default.some((channel) => !Number.isFinite(channel) || channel < 0 || channel > 1)
      )
        throw new Error(
          `Plugin color parameter ${parameter.name} must use normalized RGBA channels`,
        );
      return {
        key: parameter.name,
        label: parameter.label,
        kind: "color",
        defaultValue: packRgb(parameter.default),
      };
    case "vector":
      throw new Error(`Vector parameter ${parameter.name} is available only to scene generators`);
    case "choice": {
      if (
        parameter.choices.length === 0 ||
        new Set(parameter.choices).size !== parameter.choices.length ||
        parameter.choices.some((choice) => choice.trim().length === 0)
      )
        throw new Error(`Plugin choice parameter ${parameter.name} has invalid choices`);
      const defaultValue = parameter.choices.indexOf(parameter.default);
      if (defaultValue < 0)
        throw new Error(`Plugin choice parameter ${parameter.name} has an unknown default`);
      return {
        key: parameter.name,
        label: parameter.label,
        kind: "choice",
        defaultValue,
        min: 0,
        max: parameter.choices.length - 1,
        step: 1,
        options: [...parameter.choices],
      };
    }
    case "texture":
      return {
        key: parameter.name,
        label: parameter.label,
        kind: "texture",
        defaultValue: 0,
      };
    default:
      throw new Error(
        `Plugin parameter ${(parameter as { name?: string }).name ?? "unknown"} has an unsupported type`,
      );
  }
}

function numberStep(minimum: number, maximum: number): number {
  const span = maximum - minimum;
  if (span === 0) return 1;
  return Math.max(span / 100, 0.001);
}

function packRgb([red, green, blue]: readonly number[]): number {
  return (Math.round(red * 255) << 16) | (Math.round(green * 255) << 8) | Math.round(blue * 255);
}

function assertFinite(value: number, field: string): void {
  if (!Number.isFinite(value)) throw new Error(`Plugin ${field} must be finite`);
}

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`Plugin ${field} must not be empty`);
}

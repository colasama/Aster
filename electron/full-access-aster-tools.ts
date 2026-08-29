import { parse, resolve } from "node:path";

export interface DesktopBridgeToolRequest {
  command: string;
  arguments: Record<string, unknown>;
}

export function fullAccessDesktopBridgeRequest(
  toolName: string,
  input: Record<string, unknown>,
): DesktopBridgeToolRequest {
  switch (toolName) {
    case "get_plugin_status":
      return { command: "plugin_status", arguments: {} };
    case "install_plugin":
      return {
        command: "install_plugin",
        arguments: { source: exactPath(input.source, "source") },
      };
    case "set_plugin_enabled":
      return {
        command: "set_plugin_enabled",
        arguments: {
          pluginId: boundedString(input.pluginId, "pluginId", 256),
          enabled: booleanValue(input.enabled, "enabled"),
        },
      };
    case "set_plugin_safe_mode":
      return {
        command: "set_plugin_safe_mode",
        arguments: { safeMode: booleanValue(input.safeMode, "safeMode") },
      };
    case "set_plugin_hot_reload":
      return {
        command: "set_plugin_hot_reload",
        arguments: { enabled: booleanValue(input.enabled, "enabled") },
      };
    case "pack_project":
      return {
        command: "pack_project",
        arguments: {
          bundle: exactPath(input.bundle, "bundle"),
          destination: exactPath(input.destination, "destination"),
        },
      };
    case "unpack_project":
      return {
        command: "unpack_project",
        arguments: {
          archive: exactPath(input.archive, "archive"),
          parent: exactPath(input.parent, "parent"),
        },
      };
    case "link_project_asset": {
      const kind = input.kind;
      if (kind !== "image" && kind !== "video")
        throw new Error("Full Access asset kind must be image or video");
      return {
        command: "link_project_asset",
        arguments: {
          bundle: exactPath(input.bundle, "bundle"),
          source: exactPath(input.source, "source"),
          kind,
        },
      };
    }
    default:
      throw new Error(`Full Access Aster tool is not implemented: ${toolName}`);
  }
}

function exactPath(value: unknown, name: string): string {
  const path = resolve(boundedString(value, name, 32_768));
  if (path === parse(path).root) throw new Error(`Full Access ${name} cannot target a root`);
  return path;
}

function boundedString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum)
    throw new Error(`Full Access ${name} is invalid`);
  return value;
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Full Access ${name} must be boolean`);
  return value;
}

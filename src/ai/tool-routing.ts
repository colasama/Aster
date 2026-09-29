/**
 * Maps the consolidated public tool surface onto Aster's internal operations. Internal names stay
 * stable for services and tests; agents see one tool per concern with an `action` or `topic`.
 */

interface Route {
  name: string;
  required?: readonly string[];
  rename?: Readonly<Record<string, string>>;
  set?: Readonly<Record<string, unknown>>;
}

const ACTIONS: Readonly<Record<string, Readonly<Record<string, Route>>>> = {
  render: {
    export: { name: "export_render", required: ["path", "baseRevision", "outputKind"] },
    status: { name: "get_render_queue" },
    wait: { name: "wait_render", required: ["jobId"] },
    cancel: { name: "cancel_render", required: ["jobId"] },
  },
  reference: {
    probe: { name: "probe_reference", required: ["path"] },
    frames: { name: "read_reference_frames", required: ["path"] },
    audio: { name: "read_reference_audio", required: ["path", "start", "duration"] },
    compare: {
      name: "compare_reference",
      required: ["path", "times", "workspaceId", "workspaceRevision"],
    },
  },
  fonts: {
    list: { name: "list_fonts" },
    check: { name: "check_fonts", required: ["families"] },
    import: { name: "import_font", required: ["path", "baseRevision", "family"] },
  },
  script_modules: {
    put: { name: "put_script_module", required: ["name", "code"] },
    remove: { name: "put_script_module", required: ["name"], set: { remove: true } },
    list: { name: "list_script_modules" },
  },
  diagnostics: {
    inspect: { name: "inspect_diagnostics" },
    analyze: {
      name: "analyze_render",
      required: ["workspaceId", "workspaceRevision", "times"],
    },
    evaluate: {
      name: "evaluate_at_time",
      required: ["workspaceId", "workspaceRevision", "time"],
    },
  },
};

const PUBLIC_ACTION_TOOLS = new Set(Object.keys(ACTIONS));

export interface RoutedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export function routeToolCall(name: string, input: Record<string, unknown>): RoutedToolCall {
  if (PUBLIC_ACTION_TOOLS.has(name)) {
    const { action, ...rest } = input;
    const routes = ACTIONS[name];
    const route = typeof action === "string" ? routes[action] : undefined;
    if (!route) throw new Error(`${name} requires action: ${Object.keys(routes).join(" | ")}`);
    const missing = (route.required ?? []).filter((field) => rest[field] === undefined);
    if (missing.length)
      throw new Error(`${name} action "${String(action)}" requires ${missing.join(", ")}`);
    return { name: route.name, arguments: { ...rest, ...route.set } };
  }
  if (name === "describe") return routeDescribe(input);
  if (name === "get_execution" && input.cancel === true) {
    const { cancel: _cancel, wait: _wait, ...rest } = input;
    return { name: "cancel_execution", arguments: rest };
  }
  if (name === "get_editor_context" && input.reset === true)
    return { name: "reset_session", arguments: {} };
  if (name === "get_editor_context") {
    const { reset: _reset, ...rest } = input;
    return { name, arguments: rest };
  }
  if (name === "query_project" && input.kind === "workspace") {
    if (typeof input.workspaceId !== "string")
      throw new Error('query_project kind "workspace" requires workspaceId');
    return { name: "get_workspace_status", arguments: { workspaceId: input.workspaceId } };
  }
  if (name === "execute_aster_code") {
    const hasCode = typeof input.code === "string";
    const hasCommands = Array.isArray(input.commands);
    if (hasCode === hasCommands)
      throw new Error("execute_aster_code requires exactly one of code or commands");
    if (hasCommands) {
      const { wait: _wait, ...rest } = input;
      return { name: "execute_commands", arguments: rest };
    }
  }
  if (name === "import_assets" && input.paths === undefined) {
    if (typeof input.path !== "string") throw new Error("import_assets requires paths or path");
    const { path, ...rest } = input;
    return { name, arguments: { ...rest, paths: [path] } };
  }
  return { name, arguments: input };
}

function routeDescribe(input: Record<string, unknown>): RoutedToolCall {
  const { topic, ...rest } = input;
  if (topic === "script") return { name: "get_script_api", arguments: {} };
  if (topic === "effects") {
    const { names: _names, ...filters } = rest;
    return { name: "list_effects", arguments: filters };
  }
  if (topic === undefined || topic === "commands") {
    if (Array.isArray(rest.names))
      return { name: "get_command_schemas", arguments: { names: rest.names } };
    return {
      name: "search_capabilities",
      arguments: {
        query: typeof rest.query === "string" ? rest.query : "",
        ...(rest.category === undefined ? {} : { category: rest.category }),
        ...(rest.limit === undefined ? {} : { limit: Math.min(24, Number(rest.limit)) }),
      },
    };
  }
  throw new Error('describe topic must be "script", "commands" or "effects"');
}

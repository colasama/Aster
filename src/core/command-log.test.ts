import { describe, expect, it } from "vitest";
import { deserializeOperations, MAX_COMMAND_LOG_ENTRIES, recordOperations } from "./command-log";
import { applyOperations } from "./operations";
import { createBlankProject } from "./project";
import { validateProjectDocument } from "./project-file";

describe("serialized command log", () => {
  it("persists and replays a bounded operation transaction", () => {
    const project = createBlankProject();
    const layerId = project.compositions[0].layers[0].id;
    const operations = [{ type: "renameLayer" as const, layerId, name: "Logged edit" }];
    const entry = recordOperations(project, operations, {
      source: "ai",
      summary: "Rename the background",
    });

    const restored = validateProjectDocument(structuredClone(project));
    expect(restored.commandLog[0]).toMatchObject({
      source: "ai",
      summary: "Rename the background",
      operationTypes: ["renameLayer"],
    });
    const replayed = applyOperations(structuredClone(project), deserializeOperations(entry) ?? []);
    expect(replayed.compositions[0].layers[0].name).toBe("Logged edit");
  });

  it("keeps large payloads out of the project and trims old entries", () => {
    const project = createBlankProject();
    const layerId = project.compositions[0].layers[0].id;
    recordOperations(project, [{ type: "setTextContent", layerId, text: "x".repeat(40_000) }]);
    expect(project.commandLog[0].serializedOperations).toBeUndefined();

    for (let index = 0; index < MAX_COMMAND_LOG_ENTRIES + 5; index += 1)
      recordOperations(project, [{ type: "renameLayer", layerId, name: `Layer ${index}` }]);
    expect(project.commandLog).toHaveLength(MAX_COMMAND_LOG_ENTRIES);
    expect(project.commandLog[project.commandLog.length - 1]?.summary).toBe("Rename layer");
  });

  it("upgrades legacy documents and rejects a mismatched operation manifest", () => {
    const legacy = createBlankProject() as Partial<ReturnType<typeof createBlankProject>>;
    delete legacy.commandLog;
    expect(validateProjectDocument(legacy).commandLog).toEqual([]);

    const project = createBlankProject();
    recordOperations(project, [
      {
        type: "renameLayer",
        layerId: project.compositions[0].layers[0].id,
        name: "Valid",
      },
    ]);
    project.commandLog[0].operationTypes = ["removeLayer"];
    expect(() => validateProjectDocument(project)).toThrow("does not match");
  });
});

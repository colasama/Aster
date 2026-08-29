import { describe, expect, it } from "vitest";
import { createDemoProject } from "./project";
import { projectPluginReferences } from "./project-plugin-references";

describe("project plugin references", () => {
  it("ignores built-in effects and scene generators", () => {
    expect(projectPluginReferences(createDemoProject())).toEqual([]);
  });

  it("collects and deduplicates third-party effect and generator IDs", () => {
    const project = createDemoProject();
    project.compositions[0].layers[0].effects.push({
      id: "plugin-effect-a",
      type: "com.example.glow",
      name: "Example Glow",
      enabled: true,
      parameters: {},
    });
    project.compositions[0].layers[1].effects.push({
      id: "plugin-effect-b",
      type: "com.example.glow",
      name: "Example Glow",
      enabled: true,
      parameters: {},
    });
    const generator = project.compositions[0].layers.find((layer) => layer.generator);
    if (!generator?.generator) throw new Error("Expected demo generator");
    generator.generator.pluginId = "org.example.particles";

    expect(projectPluginReferences(project)).toEqual(["com.example.glow", "org.example.particles"]);
  });
});

import { describe, expect, it } from "vitest";
import { applyOperations } from "../core/editing/operations";
import { createBlankProject } from "../core/project/project";
import { executeScript } from "./script-runtime";

function task(code: string) {
  return { code, project: createBlankProject(), currentTime: 0, maxOperations: 4096 };
}

describe("isolated editing scripts", () => {
  it("creates more than 128 operations and replays exactly, including duplication and keys", async () => {
    const input = task(`
      const c = aster.compositions.active(); const ids = [];
      for (let i=0; i<16; i++) {
        const l = c.layers.addText({text: 'Unit '+i, position:[i*50,200,0], scale:[100,100,100]});
        l.opacity.setKeyframes([{time:0,value:0},{time:1,value:100}]); ids.push(l.id);
      }
      const copy = c.layers.get(ids[0]).duplicate('Copy');
      return {ids, copy: copy.id};
    `);
    const before = structuredClone(input.project);
    const result = await executeScript(input);
    expect(result.operations.length).toBeGreaterThan(128);
    expect(input.project).toEqual(before);
    expect({
      ...applyOperations(input.project, result.operations),
      updatedAt: result.project.updatedAt,
    }).toEqual(result.project);
    const data = result.result as { ids: string[]; copy: string };
    expect(data.ids).toHaveLength(16);
    const layers = result.project.compositions[0].layers;
    const source = layers.find((l) => l.id === data.ids[0]);
    const copy = layers.find((l) => l.id === data.copy);
    expect(copy?.name).toBe("Copy");
    expect(copy?.transform.opacity).not.toEqual(source?.transform.opacity);
  });

  it("rejects invalid commands even when guest code catches the host exception", async () => {
    const input = task(`
      aster.compositions.active().layers.addText({text:'staged'});
      try { aster.command({type:'removeLayer',layerId:'missing'}); } catch(e) {}
      return true;
    `);
    const before = structuredClone(input.project);
    await expect(executeScript(input)).rejects.toThrow("Layer does not exist");
    expect(input.project).toEqual(before);
  });

  it("exposes no renderer, Electron, network or filesystem objects", async () => {
    const result = await executeScript(
      task(
        `return ['window','document','fetch','XMLHttpRequest','process','require','Worker','WebSocket','importScripts'].map(k=>typeof globalThis[k]);`,
      ),
    );
    expect(result.result).toEqual(Array(9).fill("undefined"));
    await expect(executeScript(task(`return import('node:fs');`))).rejects.toThrow();
  });

  it("interrupts a nonterminating script and enforces the remaining workspace budget", async () => {
    await expect(executeScript(task("while(true) {}"), undefined, 25)).rejects.toMatchObject({
      code: "execution_timeout",
    });
    await expect(
      executeScript({
        ...task("for(let i=0;i<3;i++) aster.compositions.active().layers.addText({text:'x'});"),
        maxOperations: 2,
      }),
    ).rejects.toMatchObject({ code: "budget_exceeded" });
  });

  it("bounds returned data and guest allocations", async () => {
    await expect(executeScript(task(`return 'x'.repeat(100000);`))).rejects.toMatchObject({
      code: "budget_exceeded",
    });
    await expect(executeScript(task(`return new Array(20000000).fill('x');`))).rejects.toThrow();
  });
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readProjectFont } from "./font-files";

it("reads bounded supported files and rejects disguised or invalid font inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-font-"));
  try {
    const path = join(root, "test.ttf");
    await writeFile(path, Buffer.from([0, 1, 0, 0, 1, 2, 3, 4]));
    expect(await readProjectFont(path, "Example", 700)).toMatchObject({
      family: "Example",
      weight: 700,
      dataUrl: "data:font/ttf;base64,AAEAAAECAwQ=",
    });
    await expect(readProjectFont("relative.ttf", "Example")).rejects.toThrow("absolute");
    await expect(readProjectFont(path, "", 700)).rejects.toThrow("family");
    await writeFile(path, "not a font");
    await expect(readProjectFont(path, "Example")).rejects.toThrow("signature");
    await writeFile(path, Buffer.alloc(8 * 1024 * 1024 + 1));
    await expect(readProjectFont(path, "Example")).rejects.toThrow("8 MiB");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

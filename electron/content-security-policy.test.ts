import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function directiveSources(policy: string, name: string): string[] {
  const directive = policy
    .split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry === name || entry.startsWith(`${name} `));
  return directive?.split(/\s+/).slice(1) ?? [];
}

describe("renderer content security policy", () => {
  it("allows authorized local assets and embedded material data to be fetched", async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const html = await readFile(resolve(root, "index.html"), "utf8");
    const policy = html.match(/content="([^"]*connect-src[^"]*)"/)?.[1];

    expect(policy).toBeDefined();
    expect(directiveSources(policy ?? "", "connect-src")).toEqual([
      "'self'",
      "aster-asset:",
      "data:",
      "http://127.0.0.1:1420",
      "ws://127.0.0.1:1420",
    ]);
  });
});

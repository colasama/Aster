import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function formatIrSchema(input, output, root) {
  const require = createRequire(import.meta.url);
  const biome = join(dirname(require.resolve("@biomejs/biome/package.json")), "bin", "biome");
  const args = [biome, "format", "--stdin-file-path", "schemas/frame-plan.v1.json"];
  const formatted = execFileSync(process.execPath, args, {
    cwd: root,
    input: await readFile(input),
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30_000,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  JSON.parse(formatted.toString("utf8"));
  await writeFile(output, formatted, { flag: "wx" });
  return {
    schema_version: 1,
    status: "passed",
    kind: "ir_schema_format",
    path: output,
    sha256: createHash("sha256").update(formatted).digest("hex"),
    bytes: formatted.length,
    formatter: [process.execPath, ...args],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== "--input" || args[2] !== "--output")
      throw new Error("Usage: ir-gate-format --input <schema> --output <new-formatted-schema>");
    console.log(JSON.stringify(await formatIrSchema(args[1], args[3], process.cwd())));
  } catch (error) {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  }
}

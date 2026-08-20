// @vitest-environment node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AsterLogger, isRendererLogPayload, parseLogLevel } from "./logger";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aster-logger-"));
  temporaryRoots.push(root);
  return root;
}

describe("AsterLogger", () => {
  it("writes structured entries and redacts secrets", async () => {
    const root = await temporaryRoot();
    const logger = new AsterLogger({ directory: root, level: "debug", console: false });
    await logger.initialize();
    logger.info("application", "started", { apiToken: "private", version: "0.2.0" });
    await logger.flush();

    const entry = JSON.parse(await readFile(join(root, "aster.jsonl"), "utf8"));
    expect(entry).toMatchObject({
      level: "info",
      process: "main",
      scope: "application",
      event: "started",
      data: { apiToken: "[REDACTED]", version: "0.2.0" },
    });
    expect(entry.sessionId).toBeTypeOf("string");
  });

  it("rotates bounded files before an entry exceeds the configured size", async () => {
    const root = await temporaryRoot();
    const logger = new AsterLogger({
      directory: root,
      level: "debug",
      maxBytes: 400,
      maxFiles: 2,
      console: false,
    });
    await logger.initialize();
    logger.debug("test", "first", { value: "x".repeat(300) });
    logger.debug("test", "second", { value: "y".repeat(300) });
    await logger.flush();

    expect(await readFile(join(root, "aster.1.jsonl"), "utf8")).toContain('"event":"first"');
    expect(await readFile(join(root, "aster.jsonl"), "utf8")).toContain('"event":"second"');
  });
});

describe("logging input validation", () => {
  it("parses supported levels and rejects malformed renderer entries", () => {
    expect(parseLogLevel("DEBUG", "info")).toBe("debug");
    expect(parseLogLevel("verbose", "warn")).toBe("warn");
    expect(isRendererLogPayload({ level: "warn", scope: "gpu", event: "device_lost" })).toBe(true);
    expect(isRendererLogPayload({ level: "verbose", scope: "gpu", event: "device_lost" })).toBe(
      false,
    );
  });
});

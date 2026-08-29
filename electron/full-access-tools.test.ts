import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FullAccessToolService } from "./full-access-tools";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("Full Access tools", () => {
  it("performs bounded exact-path file operations with secret-free audit metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aster-full-access-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "note.txt");
    const service = new FullAccessToolService();
    await service.execute(1, "session-1", "write_file", {
      path,
      content: "bounded content",
      mode: "create",
    });
    const read = (await service.execute(1, "session-1", "read_file", { path })) as {
      content: string;
    };
    expect(read.content).toBe("bounded content");
    await service.execute(1, "session-1", "delete_path", { path });
    expect(service.auditEvents()).toMatchObject([
      { toolName: "write_file", irreversible: true, target: path },
      { toolName: "read_file", irreversible: false, target: path },
      { toolName: "delete_path", irreversible: true, target: path },
    ]);
    expect(JSON.stringify(service.auditEvents())).not.toContain("bounded content");
  });

  it("cancels agent-owned child processes on emergency stop", async () => {
    const service = new FullAccessToolService();
    const running = service.execute(9, "session-stop", "run_process", {
      executable: process.execPath,
      args: ["-e", "setTimeout(() => {}, 10000)"],
      timeoutMs: 30_000,
    });
    service.abortSession("session-stop");
    await expect(running).rejects.toThrow("cancelled");
    expect(service.auditEvents()[0]).toMatchObject({ status: "cancelled" });
  });

  it("rejects filesystem roots and over-budget content", async () => {
    const service = new FullAccessToolService();
    const root = process.platform === "win32" ? "C:\\" : "/";
    await expect(service.execute(1, "session-1", "read_file", { path: root })).rejects.toThrow(
      "filesystem root",
    );
    await expect(
      service.execute(1, "session-1", "write_file", {
        path: join(tmpdir(), "too-large.txt"),
        content: "x".repeat(1024 * 1024 + 1),
      }),
    ).rejects.toThrow("too large");
  });

  it("routes Aster plugin and project tools through the injected application service", async () => {
    const handler = vi.fn(async () => ({ plugins: [] }));
    const service = new FullAccessToolService(handler);
    await expect(service.execute(3, "session-app", "get_plugin_status", {})).resolves.toEqual({
      plugins: [],
    });
    expect(handler).toHaveBeenCalledWith("get_plugin_status", {}, expect.any(AbortSignal));
    expect(service.auditEvents()[0]).toMatchObject({
      toolName: "get_plugin_status",
      irreversible: false,
      status: "ok",
    });
  });
});

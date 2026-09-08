import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clipboard } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startAutomationServer } from "./automation-server";
import { AutomationSettingsController } from "./automation-settings";

vi.mock("electron", () => ({
  clipboard: { writeText: vi.fn() },
  ipcMain: { handle: vi.fn() },
}));

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.clearAllMocks();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aster-mcp-settings-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const cancel = vi.fn();
  const options = {
    userData: root,
    command: "C:/Aster/Aster.exe",
    launchArgs: [],
    start: (config: { port: number }) =>
      startAutomationServer({ ...config, execute: async () => ({ ok: true }), cancel }),
  };
  const controller = new AutomationSettingsController(options);
  cleanup.push(() => controller.close());
  await controller.initialize({});
  return { root, options, controller, cancel };
}
function copied() {
  return vi.mocked(clipboard.writeText).mock.calls.at(-1)?.[0] ?? "";
}
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
async function connect(port: number) {
  // Each probe targets a possibly restarted server, not an old pooled socket.
  const response = await fetch(`http://127.0.0.1:${port}/tools`, {
    headers: { connection: "close" },
  });
  await response.arrayBuffer();
  return response.status;
}

describe("MCP desktop settings", () => {
  it("enables, persists and restores a local listener without credentials", async () => {
    const { root, options, controller } = await fixture();
    expect(controller.snapshot()).toMatchObject({ enabled: false, running: false });
    controller.copy("configuration");
    const config = JSON.parse(copied()).mcpServers.aster;
    expect(config.command).toBe(options.command);
    expect(config.args).toEqual([]);
    expect(config.env).toEqual({ ASTER_AUTOMATION_PORT: "48765" });
    const port = await freePort();
    expect(await controller.update({ enabled: true, port })).toMatchObject({ running: true });
    expect(await connect(port)).toBe(200);
    expect(JSON.parse(await readFile(join(root, "automation.json"), "utf8"))).toEqual({
      version: 2,
      enabled: true,
      port,
    });
    await controller.close();
    const restored = new AutomationSettingsController(options);
    cleanup.push(() => restored.close());
    expect(await restored.initialize({})).toMatchObject({ running: true, port });
    expect(await connect(port)).toBe(200);
    await restored.update({ enabled: false });
    await expect(connect(port)).rejects.toThrow();
  });

  it("restores the old listener after a port conflict and rejects invalid changes without disturbing it", async () => {
    const { controller } = await fixture();
    const port = await freePort();
    await controller.update({ enabled: true, port });
    const blocker = await startAutomationServer({
      port: 0,
      execute: async () => ({}),
      cancel: vi.fn(),
    });
    cleanup.push(() => blocker.close());
    await expect(controller.update({ port: blocker.port })).rejects.toThrow();
    expect(controller.snapshot()).toMatchObject({ port, running: true });
    expect(await connect(port)).toBe(200);
    for (const patch of [
      { port: 0 },
      { port: 1.5 },
      { port: "1234" },
      { enabled: "true" },
      { token: "injected" },
    ])
      await expect(controller.update(patch)).rejects.toThrow();
    expect(await connect(port)).toBe(200);
  });

  it("honors environment overrides and uses an ephemeral port for background sessions", async () => {
    const { root, options } = await fixture();
    const environment = new AutomationSettingsController(options);
    cleanup.push(() => environment.close());
    expect(
      await environment.initialize({
        ASTER_AUTOMATION_ENABLED: "1",
        ASTER_AUTOMATION_PORT: "0",
      }),
    ).toMatchObject({ running: true, environmentManaged: true });
    expect(await connect(environment.snapshot().port)).toBe(200);
    await expect(environment.update({ enabled: false })).rejects.toThrow("environment variables");
    await expect(readFile(join(root, "automation.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reads old settings without requiring their encrypted token", async () => {
    const { root, options } = await fixture();
    await writeFile(
      join(root, "automation.json"),
      JSON.stringify({
        version: 1,
        enabled: false,
        port: 48765,
        token: "old-encrypted-token",
      }),
    );
    const restored = new AutomationSettingsController(options);
    cleanup.push(() => restored.close());
    expect(await restored.initialize({})).toMatchObject({ enabled: false, port: 48765 });
    await restored.update({ port: 48766 });
    expect(await readFile(join(root, "automation.json"), "utf8")).not.toContain("token");
  });
});

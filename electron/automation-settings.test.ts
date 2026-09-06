import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clipboard, safeStorage } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startAutomationServer } from "./automation-server";
import { AutomationSettingsController } from "./automation-settings";

vi.mock("electron", () => ({
  clipboard: { writeText: vi.fn() },
  ipcMain: { handle: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: vi.fn((text: string) => Buffer.from(text.split("").reverse().join(""))),
    decryptString: vi.fn((bytes: Buffer) => bytes.toString().split("").reverse().join("")),
  },
}));

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.clearAllMocks();
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aster-mcp-settings-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const cancel = vi.fn();
  const options = {
    userData: root,
    command: "C:/Aster/Aster.exe",
    adapterPath: "C:/Aster/resources/app.asar/dist-electron/electron/automation-mcp.js",
    start: (config: { token: string; port: number }) =>
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
async function authenticate(port: number, token: string) {
  // Each probe targets a possibly restarted server, not an old pooled socket.
  const response = await fetch(`http://127.0.0.1:${port}/tools`, {
    headers: { authorization: `Bearer ${token}`, connection: "close" },
  });
  await response.arrayBuffer();
  return response.status;
}

describe("MCP desktop settings", () => {
  it("enables immediately, persists encrypted credentials, rotates authorization and restores after restart", async () => {
    const { root, options, controller } = await fixture();
    expect(controller.snapshot()).toMatchObject({
      enabled: false,
      running: false,
      hasToken: false,
    });
    const port = await freePort();
    expect(await controller.update({ enabled: true, port })).toMatchObject({
      running: true,
      hasToken: true,
    });
    controller.copy("token");
    const original = copied();
    expect(await authenticate(port, original)).toBe(200);
    const saved = await readFile(join(root, "automation.json"), "utf8");
    expect(saved).not.toContain(original);
    expect(safeStorage.encryptString).toHaveBeenCalledWith(original);
    expect(JSON.stringify(controller.snapshot())).not.toContain(original);
    await controller.update({ rotateToken: true });
    controller.copy("configuration");
    const config = JSON.parse(copied()).mcpServers.aster;
    expect(config.command).toBe(options.command);
    expect(config.args).toEqual([options.adapterPath]);
    expect(config.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(await authenticate(port, original)).toBe(403);
    expect(await authenticate(port, config.env.ASTER_AUTOMATION_TOKEN)).toBe(200);
    await controller.close();
    const restored = new AutomationSettingsController(options);
    cleanup.push(() => restored.close());
    expect(await restored.initialize({})).toMatchObject({ running: true, port });
    expect(await authenticate(port, config.env.ASTER_AUTOMATION_TOKEN)).toBe(200);
    await restored.update({ enabled: false });
    await expect(authenticate(port, config.env.ASTER_AUTOMATION_TOKEN)).rejects.toThrow();
    expect(JSON.parse(await readFile(join(root, "automation.json"), "utf8")).enabled).toBe(false);
  });

  it("restores the old listener after a port conflict and rejects invalid changes without disturbing it", async () => {
    const { controller } = await fixture();
    const port = await freePort();
    await controller.update({ enabled: true, port });
    controller.copy("token");
    const token = copied();
    const blocker = await startAutomationServer({
      port: 0,
      token,
      execute: async () => ({}),
      cancel: vi.fn(),
    });
    cleanup.push(() => blocker.close());
    await expect(controller.update({ port: blocker.port })).rejects.toThrow();
    expect(controller.snapshot()).toMatchObject({ port, running: true });
    expect(await authenticate(port, token)).toBe(200);
    for (const patch of [
      { port: 0 },
      { port: 1.5 },
      { port: "1234" },
      { enabled: "true" },
      { token: "injected" },
    ])
      await expect(controller.update(patch)).rejects.toThrow();
    expect(await authenticate(port, token)).toBe(200);
  });

  it("honors environment overrides without persisting secrets and refuses plaintext storage", async () => {
    const { root, options, controller } = await fixture();
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false);
    await expect(controller.update({ enabled: true })).rejects.toThrow("Secure system storage");
    expect(controller.snapshot().running).toBe(false);
    const environment = new AutomationSettingsController(options);
    cleanup.push(() => environment.close());
    const port = await freePort();
    expect(
      await environment.initialize({
        ASTER_AUTOMATION_TOKEN: "x".repeat(64),
        ASTER_AUTOMATION_PORT: String(port),
      }),
    ).toMatchObject({ running: true, environmentManaged: true });
    await expect(environment.update({ enabled: false })).rejects.toThrow("environment variables");
    await expect(readFile(join(root, "automation.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain, protocol, session } from "electron";
import type {
  RasterServiceFrame,
  RasterServiceReady,
  RasterServiceWork,
} from "../src/renderer/native-project/raster-service-protocol.js";
import {
  ASSET_SCHEME,
  ASSET_SCHEME_REGISTRATION,
  createAssetProtocolHandler,
} from "./asset-protocol.js";
import { fetchLocalAsset } from "./local-file-response.js";
import { NativeRasterPayloads } from "./native-raster-payloads.js";
import { NativeRasterProject } from "./native-raster-project.js";
import { NativeRasterWire } from "./native-raster-wire.js";

interface Configuration {
  address: string;
  token: string;
  project: string;
  projectSha256: string;
  bundle: string;
  bridge: string;
  profile: string;
  maximumJsonBytes: number;
  maximumPixelBytes: number;
}

async function main() {
  const config: Configuration = JSON.parse(process.env.ASTER_NATIVE_RASTER_CONNECT ?? "null");
  delete process.env.ASTER_NATIVE_RASTER_CONNECT;
  assert(
    config && /^[a-f0-9]{64}$/.test(config.token) && /^[a-f0-9]{64}$/.test(config.projectSha256),
  );
  assert(
    Number.isSafeInteger(config.maximumJsonBytes) &&
      config.maximumJsonBytes >= 32 &&
      config.maximumJsonBytes <= 67108864,
  );
  assert(
    Number.isSafeInteger(config.maximumPixelBytes) &&
      config.maximumPixelBytes > 0 &&
      config.maximumPixelBytes <= 1073741824,
  );
  const project = new NativeRasterProject(
    config.project,
    config.projectSha256,
    config.bridge,
    config.profile,
    config.maximumJsonBytes,
  );
  let window: BrowserWindow | undefined,
    stopping = false,
    ready = false,
    index = 0;
  let take: ((work: RasterServiceWork | null) => void) | undefined;
  let current:
    | { work: RasterServiceWork; resolve: () => void; reject: (error: Error) => void }
    | undefined;
  let queued: RasterServiceWork | undefined;
  const rasterPayloads = new NativeRasterPayloads();
  const wire = new NativeRasterWire(
    config.address,
    config.maximumJsonBytes,
    async (value) => {
      assert(
        ready && !current && !queued && value && typeof value === "object",
        "Raster provider is not ready",
      );
      const request = value as {
        kind: string;
        index: number;
        requestSha256: string;
        knownPayloads?: string[];
        preparation: {
          header: RasterServiceWork["header"];
          operations: { kind: string; request?: RasterServiceWork["requests"][number] }[];
        };
      };
      assert.equal(request.kind, "acquire");
      assert.equal(request.index, index);
      assert(/^[a-f0-9]{64}$/.test(request.requestSha256));
      assert(
        Array.isArray(request.preparation?.operations) &&
          request.preparation.operations.length <= 65536,
      );
      const requests = request.preparation.operations.flatMap((operation) => {
        assert(["raster", "media", "target"].includes(operation.kind));
        if (operation.kind !== "raster") return [];
        assert(operation.request);
        return [operation.request];
      });
      const work: RasterServiceWork = {
        index,
        requestSha256: request.requestSha256,
        header: request.preparation.header,
        requests,
        knownPayloads: rasterPayloads.known(request.knownPayloads ?? []),
      };
      await new Promise<void>((resolveFrame, reject) => {
        current = { work, resolve: resolveFrame, reject };
        if (take) {
          const deliver = take;
          take = undefined;
          deliver(work);
        } else queued = work;
      });
    },
    (error) => {
      void stop(error);
    },
  );

  async function stop(error?: Error) {
    if (stopping) return;
    stopping = true;
    if (error)
      await wire
        .send({ kind: "error", message: String(error.message).slice(0, 4096) })
        .catch(() => {});
    take?.(null);
    take = undefined;
    current?.reject(error ?? new Error("Native raster session closed"));
    current = undefined;
    wire.dispose();
    project.dispose();
    window?.destroy();
    app.exit(error ? 1 : 0);
  }
  process.on("uncaughtException", (error) => {
    void stop(error);
  });
  process.on("unhandledRejection", (error) => {
    void stop(error instanceof Error ? error : new Error(String(error)));
  });
  protocol.registerSchemesAsPrivileged([ASSET_SCHEME_REGISTRATION]);
  app.setPath("userData", config.profile);
  for (const flag of [
    "force_high_performance_gpu",
    "disable-background-timer-throttling",
    "disable-renderer-backgrounding",
    "disable-backgrounding-occluded-windows",
  ])
    app.commandLine.appendSwitch(flag);
  await app.whenReady();
  protocol.handle(
    ASSET_SCHEME,
    createAssetProtocolHandler({
      allowedAssets: project.allowedAssets,
      fetchFile: fetchLocalAsset,
    }),
  );
  const handle = (name: string, action: (...args: never[]) => unknown) =>
    ipcMain.handle(`aster:native-raster-${name}`, async (event, ...args) => {
      assert(
        !stopping &&
          event.sender === window?.webContents &&
          event.senderFrame === window.webContents.mainFrame,
      );
      return action(...(args as never[]));
    });
  handle("desktop", (command: string, args: Record<string, unknown>) =>
    project.invoke(command, args),
  );
  handle("open", () => ({ projectPath: config.project }));
  handle("ready", async (value: RasterServiceReady) => {
    assert(!ready);
    ready = true;
    await wire.send({
      kind: "ready",
      protocol: 1,
      token: config.token,
      projectSha256: config.projectSha256,
      ready: value,
    });
  });
  handle("take", () => {
    assert(ready && !take);
    if (queued) {
      const work = queued;
      queued = undefined;
      return work;
    }
    return new Promise<RasterServiceWork | null>((deliver) => {
      take = deliver;
    });
  });
  handle("frame", async (value: RasterServiceFrame) => {
    assert(current && value.index === index && current.work.index === index);
    const { pixels, payloads, identities } = rasterPayloads.prepare(
      value.pixels,
      current.work.knownPayloads ?? [],
      config.maximumPixelBytes,
    );
    const manifest = {
      caseId: "native-raster-session",
      ...value,
      pixels,
      requestSha256: current.work.requestSha256,
    };
    await wire.send(
      {
        kind: "frame",
        index,
        manifest,
        payloads: [...payloads].map(([file, bytes]) => ({ file, byteLength: bytes.length })),
      },
      [...payloads.values()],
    );
    rasterPayloads.commit(identities);
    const complete = current.resolve;
    current = undefined;
    index++;
    complete();
  });
  handle("fail", (message: string) => {
    void stop(new Error(String(message).slice(0, 4096)));
  });
  ipcMain.on("aster:native-raster-log", (event, entry) => {
    if (event.sender === window?.webContents && entry?.level === "error")
      void stop(new Error(JSON.stringify(entry).slice(0, 4096)));
  });
  session.defaultSession.setPermissionCheckHandler(
    (contents, permission) =>
      contents === window?.webContents && String(permission) === "local-fonts",
  );
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) =>
    callback(contents === window?.webContents && String(permission) === "local-fonts"),
  );
  const url = pathToFileURL(resolve(config.bundle)).href;
  window = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    paintWhenInitiallyHidden: true,
    width: 64,
    height: 64,
    webPreferences: {
      preload: join(import.meta.dirname, "native-raster-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, destination) => {
    if (destination !== url) event.preventDefault();
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    void stop(new Error(`Raster renderer exited: ${details.reason}`));
  });
  app.on("window-all-closed", () => {});
  app.on("child-process-gone", (_event, details) => {
    if (details.type === "GPU" && !stopping)
      void stop(new Error(`Raster GPU exited: ${details.reason}`));
  });
  await window.loadURL(url);
}

void main().catch(() => app.exit(1));

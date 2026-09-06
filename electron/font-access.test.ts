import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { expect, it, vi } from "vitest";

const { handle } = vi.hoisted(() => ({ handle: vi.fn() }));
vi.mock("electron", () => ({ ipcMain: { handle } }));

import { registerFontAccess } from "./font-access";

it("restricts inventory to the editor, coalesces requests and restores background throttling on error", async () => {
  let reject!: (error: Error) => void;
  const contents = {
    id: 1,
    mainFrame: {},
    getBackgroundThrottling: () => true,
    setBackgroundThrottling: vi.fn(),
    isDestroyed: () => false,
    executeJavaScript: vi.fn(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    ),
  };
  registerFontAccess(() => ({ webContents: contents }) as unknown as BrowserWindow);
  const listener = handle.mock.calls.at(-1)?.[1] as (event: IpcMainInvokeEvent) => Promise<unknown>;
  await expect(
    listener({ sender: contents, senderFrame: {} } as unknown as IpcMainInvokeEvent),
  ).rejects.toThrow("restricted");
  const event = {
    sender: contents,
    senderFrame: contents.mainFrame,
  } as unknown as IpcMainInvokeEvent;
  const first = listener(event);
  const second = listener(event);
  expect(contents.executeJavaScript).toHaveBeenCalledTimes(1);
  expect(contents.setBackgroundThrottling).toHaveBeenCalledWith(false);
  reject(new Error("inventory unavailable"));
  const results = await Promise.allSettled([first, second]);
  expect(results.every((result) => result.status === "rejected")).toBe(true);
  expect(contents.setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
});

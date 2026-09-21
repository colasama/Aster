/// <reference types="vite/client" />

import type { AsterDesktopApi } from "./desktop/api";

declare global {
  const __APP_VERSION__: string;

  interface Window {
    asterDesktop?: AsterDesktopApi;
  }
}

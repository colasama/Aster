/// <reference types="vite/client" />

import type { AsterDesktopApi } from "./desktop/api";

declare global {
  const __APP_VERSION__: string;
  const __ASTER_TS_REFERENCE__: boolean;

  interface Window {
    asterDesktop?: AsterDesktopApi;
  }
}

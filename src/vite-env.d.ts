/// <reference types="vite/client" />

import type { AsterDesktopApi } from "./desktop/api";

declare global {
  interface Window {
    asterDesktop?: AsterDesktopApi;
  }
}

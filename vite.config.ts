import process from "node:process";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react()],

  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "react-runtime",
              test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/,
              priority: 30,
            },
            {
              name: "tauri-runtime",
              test: /node_modules[\\/]@tauri-apps[\\/]/,
              priority: 20,
            },
            {
              name: "icon-library",
              test: /node_modules[\\/]lucide-react[\\/]/,
              priority: 20,
            },
            {
              name: "effect-catalog",
              test: /src[\\/](?:effects|renderer[\\/]ae-effect-shader-cases)\b/,
              priority: 10,
              includeDependenciesRecursively: false,
            },
            {
              name: "gpu-runtime",
              test: /src[\\/]renderer[\\/]/,
              priority: 5,
              includeDependenciesRecursively: false,
            },
          ],
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));

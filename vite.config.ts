import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig(() => ({
  base: "./",
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

  // Keep Electron's development URL stable so navigation policy and HMR remain deterministic.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    watch: {
      ignored: ["**/crates/aster-desktop-bridge/**", "**/dist-electron/**"],
    },
  },
}));

import { resolve } from "node:path";
import { build } from "vite";

await build({
  root: process.cwd(),
  configFile: false,
  base: "./",
  define: { __APP_VERSION__: JSON.stringify("native-raster-provider") },
  build: {
    outDir: "dist/native-raster",
    emptyOutDir: true,
    rolldownOptions: { input: resolve("native-raster.html") },
  },
});

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const projectRoot = new URL("../", import.meta.url);
const metadata = JSON.parse(readFileSync(new URL("package.json", projectRoot), "utf8"));
const commit = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
  cwd: projectRoot,
  encoding: "utf8",
  windowsHide: true,
}).trim();

export const appVersion = `${metadata.version}+${commit}`;

export default {
  ...metadata.build,
  buildVersion: metadata.version,
  extraMetadata: { version: appVersion },
};

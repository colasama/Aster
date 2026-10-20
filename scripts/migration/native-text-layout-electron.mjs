import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow, session } from "electron";
import { sha256 } from "./m0-evidence.mjs";
import { writeAtomicJson } from "./report.mjs";

const config = JSON.parse(readFileSync(process.env.ASTER_TEXT_LAYOUT_CONFIG, "utf8"));
const extended = process.argv.includes("--extended");
const output = join(config.output, extended ? "extended" : "ordinary");
app.setPath("userData", join(output, "profile"));
if (extended) app.commandLine.appendSwitch("enable-blink-features", "ExtendedTextMetrics");
for (const flag of [
  "disable-background-timer-throttling",
  "disable-renderer-backgrounding",
  "disable-backgrounding-occluded-windows",
])
  app.commandLine.appendSwitch(flag);
let window;
const report = { status: "failed", extended, cases: [] };

async function main() {
  try {
    await mkdir(output, { recursive: true });
    await app.whenReady();
    session.defaultSession.setPermissionCheckHandler(
      (contents, permission) => contents === window?.webContents && permission === "local-fonts",
    );
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback) =>
      callback(contents === window?.webContents && permission === "local-fonts"),
    );
    window = new BrowserWindow({
      show: false,
      webPreferences: { backgroundThrottling: false, paintWhenInitiallyHidden: true },
    });
    await window.loadURL(config.url);
    report.host = await window.webContents.executeJavaScript("window.textLayoutHost()");
    assert.equal(
      report.host.fonts.status,
      "available",
      "Text layout requires authenticated system font bytes",
    );
    assert.equal(report.host.extended, extended);
    for (const assignment of config.assignments) {
      const raw = await readFile(assignment.project_path);
      assert.equal(sha256(raw), assignment.project_sha256);
      const prepared = await window.webContents.executeJavaScript(
        `window.prepareTextLayout(${raw.toString("utf8")},${JSON.stringify(assignment.case)})`,
      );
      const entry = {
        id: assignment.case.id,
        project_sha256: assignment.project_sha256,
        ...prepared,
        observations: [],
      };
      const directory = join(output, assignment.case.id);
      await mkdir(directory, { recursive: true });
      for (const [index, sample] of prepared.samples.entries()) {
        const captured = await window.webContents.executeJavaScript(
          `window.captureTextLayout(${JSON.stringify(sample)},${extended})`,
        );
        assert.deepEqual(captured.sample, sample);
        for (const record of captured.records) {
          assert.equal(record.observation_neutral, true);
          if (extended) {
            const pixels = Buffer.from(record.png, "base64");
            delete record.png;
            const name = `${index}-${record.index}.png`;
            await writeFile(join(directory, name), pixels, { flag: "wx" });
            record.image = { path: name, sha256: sha256(pixels) };
          }
        }
        const name = `${index}.json`;
        await writeAtomicJson(join(directory, name), captured);
        entry.observations.push({
          path: name,
          sha256: sha256(await readFile(join(directory, name))),
          records: captured.records.length,
        });
        if (index % 25 === 0)
          process.stdout.write(
            `${assignment.case.id} ${extended ? "extended" : "ordinary"} ${index + 1}/${prepared.samples.length}\n`,
          );
      }
      assert.equal(sha256(await readFile(assignment.project_path)), assignment.project_sha256);
      report.cases.push(entry);
    }
    report.host_after = await window.webContents.executeJavaScript("window.textLayoutHost()");
    assert.deepEqual(
      report.host_after,
      report.host,
      "Font or host inputs changed during layout capture",
    );
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? String(error);
  } finally {
    await writeAtomicJson(join(output, "report.json"), report);
    window?.destroy();
    app.exit(report.status === "passed" ? 0 : 1);
  }
}
void main();

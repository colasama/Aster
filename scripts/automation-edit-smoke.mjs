import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// pnpm build && node scripts/automation-edit-smoke.mjs
// The MCP adapter owns a private, hidden Electron editor and shuts it down on disconnect.
const root = resolve(import.meta.dirname, "..");
const output = join(root, "artifacts", `automation-edit-${Date.now()}`);
await mkdir(output, { recursive: true });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "dist-electron/electron/automation-mcp.js"), "--background"],
  stderr: "pipe",
});
let log = "";
transport.stderr?.on("data", (data) => {
  log = (log + data).slice(-512 * 1024);
});
const client = new Client({ name: "aster-edit-smoke", version: "1.0.0" });
const report = { steps: [], output };
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 125_000 });
  const text = result.content.find((item) => item.type === "text")?.text;
  if (result.isError) throw new Error(`${name}: ${text}`);
  if (name === "render_preview") {
    const image = result.content.find((item) => item.type === "image");
    if (image) await writeFile(join(output, "preview.png"), Buffer.from(image.data, "base64"));
  }
  return JSON.parse(text);
}
async function complete(job) {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const status = await call("get_execution", { executionId: job.executionId });
    if (status.state !== "running") return status;
    await delay(100);
  }
  throw new Error("Script status did not settle");
}
function passed(step) {
  report.steps.push(step);
  process.stdout.write(`${step}: OK\n`);
}
try {
  await client.connect(transport, { timeout: 90_000 });
  const tools = await client.listTools();
  assert.equal(
    tools.tools.find((t) => t.name === "execute_commands").inputSchema.properties.commands.maxItems,
    256,
  );
  await call("get_script_api");
  const context = await call("get_editor_context");
  const input = {
    baseRevision: context.projectRevision,
    requestId: "bulk",
    code: `
    const c = aster.compositions.active(); const ids = [];
    for(let i=0;i<16;i++) {
      const l=c.layers.addText({text:'Unit '+i, position:[100+i*90,300,0],scale:[100,100,100]});
      l.opacity.setKeyframes([{time:0,value:0},{time:1,value:100}]); ids.push(l.id);
      aster.progress((i+1)/16,'Creating units');
    }
    return {ids, isolated:typeof fetch==='undefined' && typeof process==='undefined' && typeof document==='undefined'};
  `,
  };
  const job = await call("execute_aster_code", input);
  assert.equal((await call("execute_aster_code", input)).executionId, job.executionId);
  const done = await complete(job);
  assert.equal(done.state, "succeeded", JSON.stringify(done));
  assert.equal(done.result.ids.length, 16);
  assert(done.result.isolated);
  const address = { workspaceId: job.workspaceId, workspaceRevision: done.workspaceRevision };
  const status = await call("get_workspace_status", { workspaceId: job.workspaceId });
  assert(status.budgets.operations.used > 128);
  passed("isolated Worker/WASM, bulk scripting and retry deduplication");
  const failed = await complete(
    await call("execute_aster_code", {
      ...address,
      code: "aster.compositions.active().layers.addText({text:'discard'}); throw new Error('rollback');",
    }),
  );
  assert.equal(failed.state, "failed");
  assert.equal(
    (await call("get_workspace_status", { workspaceId: job.workspaceId })).budgets.operations.used,
    status.budgets.operations.used,
  );
  passed("script failure preserves prior workspace");
  const looping = await call("execute_aster_code", { ...address, code: "while(true){}" });
  await delay(300);
  const started = Date.now();
  await call("get_editor_context");
  report.responsivenessMs = Date.now() - started;
  assert(report.responsivenessMs < 2000);
  assert.equal(
    (await call("cancel_execution", { executionId: looping.executionId })).state,
    "cancelled",
  );
  passed("renderer stays responsive and cancellation terminates Worker");
  const timedOut = await complete(
    await call("execute_aster_code", { ...address, code: "while(true){}" }),
  );
  assert.equal(timedOut.state, "failed");
  assert.equal(timedOut.error.code, "execution_timeout");
  passed("hard execution deadline");
  const bulk = await call("execute_commands", {
    ...address,
    commands: Array.from({ length: 256 }, (_, i) => ({
      type: "renameLayer",
      layerId: done.result.ids[0],
      name: `Unit ${i}`,
    })),
  });
  const finalAddress = { workspaceId: job.workspaceId, workspaceRevision: bulk.workspaceRevision };
  const preview = await call("render_preview", { ...finalAddress, times: [1], maxDimension: 512 });
  assert.equal(preview.status, "rendered");
  await call("submit_workspace", { ...finalAddress, summary: "Bulk script smoke" });
  const commitInput = { ...finalAddress, requestId: "commit-once" };
  const committed = await call("commit_workspace", commitInput);
  assert.deepEqual(await call("commit_workspace", commitInput), committed);
  assert.equal(
    (await call("begin_edit_workspace", { baseRevision: committed.projectRevision }))
      .workspaceRevision,
    0,
  );
  passed(
    "256-command Worker batch, GPU preview, idempotent commit and same-connection continuation",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error);
  process.stderr.write(`${error}\n`);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(join(output, "application.log"), log);
  process.stdout.write(`Report: ${output}\n`);
}

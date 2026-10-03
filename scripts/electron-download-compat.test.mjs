import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { dirname, join, resolve, sep } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder"));
const libraryRoot = dirname(builderRequire.resolve("app-builder-lib/package.json"));
const { ElectronFetchDownloader } = require(
  join(libraryRoot, "out/util/electronFetchDownloader.js"),
);
const { downloadElectronArtifactZip } = require(join(libraryRoot, "out/util/electronGet.js"));

class DownloadFixture {
  servers = [];
  sockets = new Set();

  static async create(context) {
    const fixture = new DownloadFixture();
    fixture.parent = resolve("artifacts/migration/download-compat");
    await mkdir(fixture.parent, { recursive: true });
    fixture.directory = await mkdtemp(join(fixture.parent, "case-"));
    context.after(async () => {
      for (const socket of fixture.sockets) socket.destroy();
      await Promise.all(fixture.servers.map((server) => new Promise((done) => server.close(done))));
      assert.ok(resolve(fixture.directory).startsWith(`${fixture.parent}${sep}`));
      await rm(fixture.directory, { recursive: true });
    });
    return fixture;
  }

  async server(handler) {
    const server = createServer(handler);
    this.servers.push(server);
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return { server, url: `http://127.0.0.1:${address.port}` };
  }

  artifactOptions(url, payload, overrides = {}) {
    return {
      artifactName: "aster-download-test",
      platformName: "win32",
      arch: "x64",
      version: "43.5.0",
      cacheDir: join(this.directory, "cache"),
      electronDownload: {
        mirrorOptions: { resolveAssetURL: async () => url },
        checksums: {
          "aster-download-test-v43.5.0-win32-x64.zip": createHash("sha256")
            .update(payload)
            .digest("hex"),
        },
        downloadOptions: { agent: {}, quiet: true },
        ...overrides,
      },
    };
  }
}

test("builder retries HTTP 503 and retains artifact checksum and cache behavior", async (context) => {
  const fixture = await DownloadFixture.create(context);
  const payload = Buffer.from("deterministic builder download fixture\n");
  let requests = 0;
  const { url } = await fixture.server((_request, response) => {
    requests += 1;
    if (requests === 1) {
      response.writeHead(503);
      response.end("retry");
    } else {
      response.writeHead(200, { "Content-Length": payload.length });
      response.end(payload);
    }
  });
  const options = fixture.artifactOptions(url, payload);
  const downloaded = await downloadElectronArtifactZip(options);
  assert.deepEqual(await readFile(downloaded), payload);
  assert.equal(requests, 2);
  assert.equal(await downloadElectronArtifactZip(options), downloaded);
  assert.equal(requests, 2, "the verified artifact cache should avoid another request");
});

test("builder rejects incorrect checksum instead of publishing a cached artifact", async (context) => {
  const fixture = await DownloadFixture.create(context);
  const payload = Buffer.from("actual content");
  const { url } = await fixture.server((_request, response) => {
    response.writeHead(200, { "Content-Length": payload.length });
    response.end(payload);
  });
  await assert.rejects(
    downloadElectronArtifactZip(fixture.artifactOptions(url, Buffer.from("expected content"))),
    /checksum|match/i,
  );
});

test("request timeout aborts a stalled download with the builder retry error code", async (context) => {
  const fixture = await DownloadFixture.create(context);
  const { url } = await fixture.server(() => {});
  const start = performance.now();
  await assert.rejects(
    new ElectronFetchDownloader().download(url, join(fixture.directory, "stalled.bin"), {
      timeout: { request: 40 },
      quiet: true,
    }),
    (error) => error.code === "ETIMEDOUT",
  );
  assert.ok(performance.now() - start < 3000);
});

test("legacy proxy agents preserve CONNECT routing and credentials without origin leakage", async (context) => {
  const fixture = await DownloadFixture.create(context);
  const payload = Buffer.from("proxied artifact");
  let originRequests = 0;
  const origin = await fixture.server((request, response) => {
    originRequests += 1;
    assert.equal(request.headers["proxy-authorization"], undefined);
    response.writeHead(200, { "Content-Length": payload.length });
    response.end(payload);
  });
  let tunnels = 0;
  const proxy = await fixture.server((_request, response) => {
    response.writeHead(500);
    response.end("CONNECT required");
  });
  proxy.server.on("connect", (request, socket, head) => {
    tunnels += 1;
    assert.equal(request.url, new URL(origin.url).host);
    assert.equal(
      request.headers["proxy-authorization"],
      `Basic ${Buffer.from("fixture:password").toString("base64")}`,
    );
    const target = new URL(origin.url);
    const upstream = connect(Number(target.port), target.hostname, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    fixture.sockets.add(upstream);
    upstream.on("error", () => socket.destroy());
    upstream.once("close", () => fixture.sockets.delete(upstream));
    socket.on("error", () => upstream.destroy());
  });
  const proxyUrl = new URL(proxy.url);
  proxyUrl.username = "fixture";
  proxyUrl.password = "password";
  const downloaded = await downloadElectronArtifactZip(
    fixture.artifactOptions(origin.url, payload, {
      downloadOptions: {
        timeout: { request: 3000 },
        agent: { http: { proxy: proxyUrl, proxyHeaders: {} } },
        quiet: true,
      },
    }),
  );
  assert.deepEqual(await readFile(downloaded), payload);
  assert.equal(originRequests, 1);
  assert.equal(tunnels, 1);
});

test("unsupported legacy options fail explicitly rather than being ignored by fetch", async (context) => {
  const fixture = await DownloadFixture.create(context);
  const downloader = new ElectronFetchDownloader();
  for (const options of [
    { timeout: { socket: 1000 } },
    { retry: { limit: 2 } },
    { agent: { http: {} } },
  ]) {
    await assert.rejects(
      downloader.download("http://127.0.0.1:1", join(fixture.directory, "unused.bin"), options),
      /support|agent/i,
    );
  }
});

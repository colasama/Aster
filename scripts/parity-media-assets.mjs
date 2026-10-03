import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeFrameIdentity,
  MEDIA_HEIGHT,
  MEDIA_WIDTH,
  pngFrame,
  psdImage,
  rgbaFrame,
  wavAudio,
} from "./parity-media-primitives.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extension = process.platform === "win32" ? ".exe" : "";
const ffmpeg = join(root, "build", "ffmpeg", `ffmpeg${extension}`);
const ffprobe = join(root, "build", "ffmpeg", `ffprobe${extension}`);
const temporary = mkdtempSync(join(tmpdir(), "aster-parity-media-"));
if (dirname(resolve(temporary)) !== resolve(tmpdir()))
  throw new Error("Refusing cleanup outside the temporary media directory");
const assets = {};

function run(binary, args, input) {
  const result = spawnSync(binary, args, { input, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0)
    throw new Error(`${binary}: ${result.error?.message ?? result.stderr.toString()}`);
  return result.stdout;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function add(name, mimeType, bytes, extra = {}) {
  assets[name] = {
    mimeType,
    byteLength: bytes.length,
    sha256: sha256(bytes),
    data: bytes.toString("base64"),
    ...extra,
  };
}

try {
  add("pattern.png", "image/png", pngFrame(42), { width: MEDIA_WIDTH, height: MEDIA_HEIGHT });
  const stillInput = [
    "-f",
    "rawvideo",
    "-pixel_format",
    "rgba",
    "-video_size",
    `${MEDIA_WIDTH}x${MEDIA_HEIGHT}`,
    "-i",
    "pipe:0",
    "-frames:v",
    "1",
  ];
  for (const [name, mime, options] of [
    ["pattern.jpg", "image/jpeg", ["-c:v", "mjpeg", "-q:v", "2", "-pix_fmt", "yuvj444p"]],
    [
      "pattern.exr",
      "image/x-exr",
      ["-c:v", "exr", "-pix_fmt", "gbrpf32le", "-compression", "zip1"],
    ],
  ]) {
    const output = join(temporary, name);
    run(
      ffmpeg,
      [
        "-v",
        "error",
        "-y",
        ...stillInput,
        ...options,
        "-threads",
        "1",
        "-fflags",
        "+bitexact",
        "-flags:v",
        "+bitexact",
        output,
      ],
      rgbaFrame(42),
    );
    const samples = [];
    if (name.endsWith(".exr")) {
      const linear = run(ffmpeg, [
        "-v",
        "error",
        "-i",
        output,
        "-f",
        "rawvideo",
        "-pix_fmt",
        "gbrpf32le",
        "-threads",
        "1",
        "pipe:1",
      ]);
      for (const [x, y] of [
        [12, 20],
        [24, 20],
        [48, 40],
      ]) {
        const pixel = y * MEDIA_WIDTH + x;
        samples.push({
          x,
          y,
          rgb: [2, 0, 1].map((plane) =>
            linear.readFloatLE((plane * MEDIA_WIDTH * MEDIA_HEIGHT + pixel) * 4),
          ),
        });
      }
    }
    add(name, mime, readFileSync(output), {
      width: MEDIA_WIDTH,
      height: MEDIA_HEIGHT,
      ...(samples.length ? { linearSamples: samples } : {}),
    });
  }
  add("pulse.wav", "audio/wav", wavAudio(), {
    sampleRate: 48_000,
    channels: 2,
    sampleCount: 96_000,
    duration: 2,
  });
  add("pattern.psd", "image/vnd.adobe.photoshop", psdImage(), {
    width: MEDIA_WIDTH,
    height: MEDIA_HEIGHT,
    layerCount: 1,
  });
  add(
    "pattern.svg",
    "image/svg+xml",
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="64" viewBox="0 0 96 64"><defs><linearGradient id="a"><stop stop-color="#f08020"/><stop offset="1" stop-color="#2080f0"/></linearGradient></defs><rect x="4" y="4" width="88" height="56" rx="8" fill="url(#a)"/><path d="M12 48L32 12L52 48Z" fill="#ffffff" fill-opacity="0.5"/><circle cx="70" cy="32" r="14" fill="none" stroke="#ffffff" stroke-width="3"/></svg>',
    ),
    { width: MEDIA_WIDTH, height: MEDIA_HEIGHT },
  );
  for (let frame = 0; frame < 4; frame += 1)
    add(`sequence-${String(frame).padStart(4, "0")}.png`, "image/png", pngFrame(frame), {
      width: MEDIA_WIDTH,
      height: MEDIA_HEIGHT,
      frame,
    });
  const frameCount = 72;
  const rgba = Buffer.concat(Array.from({ length: frameCount }, (_, frame) => rgbaFrame(frame)));
  for (const numerator of [24_000, 30_000]) {
    const rate = `${numerator}/1001`;
    const name = `barcode-${numerator}-1001.mp4`;
    const output = join(temporary, name);
    run(
      ffmpeg,
      [
        "-v",
        "error",
        "-y",
        "-f",
        "rawvideo",
        "-pixel_format",
        "rgba",
        "-video_size",
        `${MEDIA_WIDTH}x${MEDIA_HEIGHT}`,
        "-framerate",
        rate,
        "-i",
        "pipe:0",
        "-frames:v",
        `${frameCount}`,
        "-an",
        "-vf",
        "scale=in_range=full:out_range=tv:out_color_matrix=bt709",
        "-c:v",
        "libx264",
        "-preset",
        "veryslow",
        "-crf",
        "12",
        "-pix_fmt",
        "yuv420p",
        "-g",
        "12",
        "-bf",
        "0",
        "-x264-params",
        "keyint=12:min-keyint=12:scenecut=0:open-gop=0",
        "-threads",
        "1",
        "-fflags",
        "+bitexact",
        "-flags:v",
        "+bitexact",
        "-map_metadata",
        "-1",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-colorspace",
        "bt709",
        "-color_range",
        "tv",
        "-movflags",
        "+faststart",
        output,
      ],
      rgba,
    );
    const probe = JSON.parse(
      run(ffprobe, [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_streams",
        "-show_frames",
        "-show_entries",
        "stream=codec_name,pix_fmt,width,height,avg_frame_rate,r_frame_rate,nb_frames,time_base,duration_ts,color_space,color_transfer,color_primaries,color_range:frame=key_frame,best_effort_timestamp,pict_type",
        "-of",
        "json",
        output,
      ]),
    );
    const rgb = run(ffmpeg, [
      "-v",
      "error",
      "-i",
      output,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-threads",
      "1",
      "pipe:1",
    ]);
    const frameBytes = MEDIA_WIDTH * MEDIA_HEIGHT * 3;
    const decodedIds = Array.from({ length: frameCount }, (_, index) =>
      decodeFrameIdentity(rgb.subarray(index * frameBytes, (index + 1) * frameBytes)),
    );
    if (
      rgb.length !== frameCount * frameBytes ||
      decodedIds.some((value, index) => value !== index)
    )
      throw new Error(`Frame-identity proof failed for ${name}`);
    add(name, "video/mp4", readFileSync(output), {
      width: MEDIA_WIDTH,
      height: MEDIA_HEIGHT,
      frameRate: { numerator, denominator: 1001 },
      frameCount,
      duration: (frameCount * 1001) / numerator,
      gop: 12,
      stream: probe.streams[0],
      keyframes: probe.frames.flatMap((frame, index) => (frame.key_frame === 1 ? [index] : [])),
      decodedFrameIdentities: decodedIds,
    });
  }
  const document = {
    version: 1,
    provenance: {
      generator: "scripts/parity-media-assets.mjs",
      origin: "Procedurally generated Aster test media; no external or owner media",
      ffmpeg: {
        sha256: sha256(readFileSync(ffmpeg)),
        version: run(ffmpeg, ["-version"]).toString().split(/\r?\n/)[0],
      },
      ffprobe: {
        sha256: sha256(readFileSync(ffprobe)),
        version: run(ffprobe, ["-version"]).toString().split(/\r?\n/)[0],
      },
      frameIdentity: {
        kind: "binary-luma-cells",
        bits: 7,
        bitOrder: "least-significant-first",
        centerY: 20,
        firstCenterX: 12,
        cellStride: 12,
        threshold: 128,
      },
    },
    assets,
  };
  const destination = join(root, "tests", "parity", "assets", "media-assets.json");
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  if (process.argv.includes("--check")) {
    if (JSON.stringify(JSON.parse(readFileSync(destination, "utf8"))) !== JSON.stringify(document))
      throw new Error(
        "Parity media assets differ; regenerate with node scripts/parity-media-assets.mjs",
      );
  } else {
    const formatted = run(
      process.execPath,
      [
        join(root, "node_modules", "@biomejs", "biome", "bin", "biome"),
        "format",
        "--stdin-file-path",
        destination,
      ],
      serialized,
    );
    writeFileSync(destination, formatted);
  }
  process.stdout.write(
    `Verified ${Object.keys(assets).length} deterministic parity media assets\n`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

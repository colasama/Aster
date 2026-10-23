import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { sha256 } from "./m0-evidence.mjs";
import { matchQualifiedText } from "./native-project-text-qualification.mjs";
import { writeAtomicJson } from "./report.mjs";

/** Preserve every evaluator byte while giving an already-qualified glyph pair one comparison name. */
export function canonicalTextPlan(plan, packets, replacements, codecs) {
  const slice = plan.metadata.slices[0];
  assert.equal(plan.metadata.slices.length, 1);
  assert.equal(slice.kind, "frame_bundle");
  assert.equal(slice.precompositions, null, "Nested native text needs independent qualification");
  assert.equal(slice.effect, null);
  assert.equal(slice.temporal.length, 0);
  assert.equal(slice.generators.length, 0);
  assert(slice.effects.every((e) => e.status === "direct"));
  const mapping = new Map(replacements.map(({ from, packet }) => [from, packet.message.hash]));
  assert.equal(mapping.size, replacements.length);
  const output = new Map(packets);
  for (const { from, packet } of replacements) {
    assert(output.delete(from), "Qualified resource is absent");
    assert(!output.has(packet.message.hash), "Qualified replacement collides");
    output.set(packet.message.hash, packet);
  }
  const remap = (value) => {
    if (typeof value === "string") return mapping.get(value) ?? value;
    if (Array.isArray(value)) return value.map(remap);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remap(v)]));
  };
  const metadata = (original) => ({
    ...original,
    // Headers and binary payloads cannot be substituted by a raster qualification.
    resources: original.resources.map((hash) => mapping.get(hash) ?? hash).sort(),
    slices: remap(original.slices),
  });
  const stages = [
    ...["scene", "root", "post", "motion", "output", "auxiliary"].map((key) => slice[key]),
    ...slice.effects.map((e) => e.execution),
  ].filter(Boolean);
  for (const hash of new Set(stages)) {
    const packet = packets.get(hash);
    assert.equal(packet?.message.kind, "buffer");
    const stage = codecs.decodeFramePlan(packet.bytes);
    const next = metadata(stage.metadata);
    if (JSON.stringify(next) === JSON.stringify(stage.metadata)) continue;
    const bytes = codecs.encodeFramePlan(next, stage.blobs);
    const content = {
      kind: "buffer",
      descriptor: { element_type: "u8", element_count: bytes.length, byte_length: bytes.length },
    };
    const replaced = codecs.contentResourceHashSync(content, bytes);
    output.delete(hash);
    output.set(replaced, { message: { type: "put_resource", hash: replaced, ...content }, bytes });
    mapping.set(hash, replaced);
  }
  return { bytes: codecs.encodeFramePlan(metadata(plan.metadata), plan.blobs), packets: output };
}

export async function buildQualifiedTextPlan(context, reader, codecs, qualification, input) {
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  const load = async (path, directory, expected) => {
    const file = await reader.bytes(local(path), expected);
    const plan = codecs.decodeFramePlan(file.bytes);
    const messages = await reader.json(local(join(dirname(path), "resources.json")));
    const packets = new Map();
    for (const message of messages) {
      assert.equal(message.type, "put_resource");
      assert(!packets.has(message.hash));
      const packet = await reader.bytes(local(join(directory, `${message.hash}.bin`)));
      assert.equal(codecs.contentResourceHashSync(message, packet.bytes), message.hash);
      packets.set(message.hash, { message, bytes: packet.bytes });
    }
    assert.deepEqual([...packets.keys()].sort(), plan.metadata.resources);
    return { plan, packets, pin: { path: local(path), sha256: file.sha256 } };
  };
  const reference = await load(input.reference, input.reference_resources, input.reference_sha256);
  const native = await load(input.candidate, input.candidate_resources, input.frame.plan_sha256);
  const bundle = reference.plan.metadata.slices[0];
  assert.equal(bundle.kind, "frame_bundle");
  assert.deepEqual(native.plan.metadata.header, reference.plan.metadata.header);
  const routes = input.frame.text_routes.filter((r) => r.frame !== null);
  assert(routes.length > 0);
  assert.equal(routes.length, input.frame.native_text_pixels.length);
  const replacements = [],
    proofs = [];
  for (const route of routes) {
    const frame = native.packets.get(route.frame);
    assert.equal(frame?.message.kind, "media_frame");
    const source = native.packets.get(frame.message.descriptor.source);
    assert.equal(source?.message.kind, "media_source");
    assert.equal(source.message.descriptor.source_id, route.capability.request.layer);
    const oldSources = [...reference.packets.values()].filter(
      (p) =>
        p.message.kind === "media_source" &&
        p.message.descriptor.source_id === source.message.descriptor.source_id,
    );
    assert.equal(oldSources.length, 1);
    const oldSource = oldSources[0];
    for (const key of ["source_id", "authorization_scope", "media_kind"])
      assert.deepEqual(source.message.descriptor[key], oldSource.message.descriptor[key]);
    assert.equal(source.message.descriptor.media_kind, "raster");
    const oldFrames = [...reference.packets.values()].filter(
      (p) =>
        p.message.kind === "media_frame" && p.message.descriptor.source === oldSource.message.hash,
    );
    assert.equal(oldFrames.length, 1);
    const oldFrame = oldFrames[0];
    assert.deepEqual(
      { ...frame.message.descriptor, source: oldSource.message.hash },
      oldFrame.message.descriptor,
    );
    const pixel = input.frame.native_text_pixels.find((p) => p.frame === route.frame);
    const oldPixel = bundle.media_pixels.find((p) => p.frame === oldFrame.message.hash);
    assert(pixel && oldPixel);
    assert(
      native.plan.metadata.slices[0].media_pixels.some(
        (p) => p.frame === pixel.frame && p.pixels === pixel.pixels,
      ),
    );
    const currentPixels = native.packets.get(pixel.pixels),
      previousPixels = reference.packets.get(oldPixel.pixels);
    assert.equal(currentPixels?.message.kind, "raster_pixels");
    assert.equal(currentPixels.message.descriptor.frame, route.frame);
    assert(previousPixels);
    const { width, height, sample } = frame.message.descriptor;
    for (const key of ["width", "height", "format"])
      assert.deepEqual(currentPixels.message.descriptor[key], frame.message.descriptor[key]);
    assert.equal(sample.kind, "raster");
    assert.equal(sample.origin, "text");
    assert.equal(currentPixels.bytes.length, width * height * 4);
    assert.equal(previousPixels.bytes.length, width * height * 4);
    const words = sample.bounds_f64_le,
      bounds = [];
    for (let i = 0; i < 8; i += 2) {
      const bytes = Buffer.alloc(8);
      bytes.writeUInt32LE(words[i], 0);
      bytes.writeUInt32LE(words[i + 1], 4);
      bounds.push(bytes.readDoubleLE());
    }
    proofs.push(
      matchQualifiedText(qualification, {
        case_id: input.case_id,
        authored_sha256: input.authored_sha256,
        route,
        width,
        height,
        bounds,
        time: input.time,
        reference_gpu_sha256: sha256(previousPixels.bytes),
        candidate_gpu_sha256: sha256(currentPixels.bytes),
      }),
    );
    replacements.push(
      { from: source.message.hash, packet: oldSource },
      { from: frame.message.hash, packet: oldFrame },
      { from: pixel.pixels, packet: previousPixels },
    );
  }
  const canonical = canonicalTextPlan(native.plan, native.packets, replacements, codecs);
  const proof = {
    kind: "m10-qualified-text-comparison-view",
    reference: reference.pin,
    candidate: native.pin,
    qualification: proofs,
    replacements: replacements.map((p) => ({ from: p.from, to: p.packet.message.hash })),
    plan: { sha256: sha256(canonical.bytes) },
  };
  return { canonical, proof };
}

export async function qualifyProjectTextPlan(context, reader, codecs, qualification, input) {
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  const { canonical, proof } = await buildQualifiedTextPlan(
    context,
    reader,
    codecs,
    qualification,
    input,
  );
  const directory = input.output,
    resources = join(directory, "resources");
  await mkdir(resources, { recursive: true });
  await writeFile(join(directory, "plan.fpln"), canonical.bytes, { flag: "wx" });
  await writeAtomicJson(
    join(directory, "resources.json"),
    [...canonical.packets.values()]
      .map((p) => p.message)
      .sort((a, b) => a.hash.localeCompare(b.hash)),
  );
  for (const packet of canonical.packets.values())
    await writeFile(join(resources, `${packet.message.hash}.bin`), packet.bytes, { flag: "wx" });
  proof.plan.path = local(join(directory, "plan.fpln"));
  const proofPath = join(directory, "qualification.json");
  await writeAtomicJson(proofPath, proof);
  return {
    path: local(proofPath),
    sha256: (await reader.bytes(local(proofPath))).sha256,
    plan: proof.plan,
    resources: local(resources),
  };
}

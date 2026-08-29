import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "../core/layer-factory";
import { createBlankProject } from "../core/project";
import { evaluateWorldTransform, flattenSceneLayers } from "../core/scene-evaluation";
import { buildSceneGeometry, FLOATS_PER_VERTEX, VERTEX_FLOAT_OFFSETS } from "./geometry";
import { createDefaultBezierPath } from "./vector-path";

describe("GPU scene geometry", () => {
  it("emits an untextured solid quad and never emits null pixels or effect geometry", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const solid = createLayerForComposition("solid", composition);
    const nullLayer = createLayerForComposition("null", composition);
    if (!solid.solid) throw new Error("Expected solid settings");
    solid.solid = { width: 640, height: 320, color: [0.2, 0.4, 0.6, 0.8] };
    solid.size = [1, 1];
    solid.color = [1, 0, 0, 1];
    nullLayer.effects.push({
      id: "null-glow",
      type: "glow",
      name: "Glow",
      enabled: true,
      parameters: {},
    });
    nullLayer.threeDimensional = true;
    composition.layers = [nullLayer, solid];

    const geometry = buildSceneGeometry(composition, flattenSceneLayers(composition, project, 0));
    expect(geometry.batches).toHaveLength(1);
    expect(geometry.batches[0]).toMatchObject({ layer: solid, vertexCount: 6 });
    expect(geometry.data[VERTEX_FLOAT_OFFSETS.mediaType]).toBe(0);
    expect(geometry.data[VERTEX_FLOAT_OFFSETS.color]).toBeCloseTo(0.2);
    expect(geometry.data[VERTEX_FLOAT_OFFSETS.color + 3]).toBeCloseTo(0.8);
    expect(geometry.data[VERTEX_FLOAT_OFFSETS.position]).toBeCloseTo(-640 / composition.width);
    expect(geometry.data[VERTEX_FLOAT_OFFSETS.position + 1]).toBeCloseTo(320 / composition.height);
    expect(geometry.data[VERTEX_FLOAT_OFFSETS.material + 3]).toBe(0);

    solid.threeDimensional = true;
    const geometry3d = buildSceneGeometry(composition, flattenSceneLayers(composition, project, 0));
    expect(geometry3d.data[VERTEX_FLOAT_OFFSETS.material + 3]).toBe(1);
  });

  it("projects 3D rotation and depth into screen-space vertices", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const mesh = createLayerForComposition("mesh", composition);
    if (!mesh.material) throw new Error("Expected mesh material");
    mesh.material.alphaMode = "mask";
    mesh.material.alphaCutoff = 0.42;
    composition.layers = [mesh];
    const flatGeometry = buildSceneGeometry(
      composition,
      flattenSceneLayers(composition, project, 0),
    );
    const flat = flatGeometry.data;
    expect(flatGeometry.batches[0].vertexCount).toBe(36);
    expect(
      new Set(Array.from({ length: 36 }, (_, index) => flat[index * FLOATS_PER_VERTEX + 2])).size,
    ).toBeGreaterThan(1);
    mesh.transform.rotation[0] = { mode: "static", value: 58 };
    mesh.transform.position[2] = { mode: "static", value: 480 };
    const projected = buildSceneGeometry(
      composition,
      flattenSceneLayers(composition, project, 0),
    ).data;
    expect(projected[0]).not.toBeCloseTo(flat[0]);
    expect(projected[1]).not.toBeCloseTo(flat[1]);
    expect(projected[VERTEX_FLOAT_OFFSETS.material + 3]).toBe(1);
    expect(projected[VERTEX_FLOAT_OFFSETS.worldPosition + 2]).not.toBe(0);
    expect(projected[VERTEX_FLOAT_OFFSETS.gradientStyleParameters]).toBe(1);
    expect(projected[VERTEX_FLOAT_OFFSETS.gradientStyleParameters + 1]).toBeCloseTo(0.42);
  });

  it("projects 3D geometry relative to the active camera transform", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const mesh = createLayerForComposition("mesh", composition);
    const camera = createLayerForComposition("camera", composition);
    composition.layers = [mesh, camera];
    const scene = flattenSceneLayers(composition, project, 0);
    const centered = buildSceneGeometry(composition, scene, {
      transform: evaluateWorldTransform(camera, composition, 0),
      settings: camera.camera ?? {
        projection: "perspective",
        fieldOfView: 50,
        orthographicSize: composition.height,
      },
    }).data;
    camera.transform.position[0] = { mode: "static", value: composition.width * 0.35 };
    camera.transform.rotation[1] = { mode: "static", value: 14 };
    const moved = buildSceneGeometry(composition, scene, {
      transform: evaluateWorldTransform(camera, composition, 0),
      settings: camera.camera ?? {
        projection: "perspective",
        fieldOfView: 50,
        orthographicSize: composition.height,
      },
    }).data;
    expect(moved[0]).not.toBeCloseTo(centered[0]);
    expect(moved[2]).not.toBeCloseTo(centered[2]);
  });

  it("supports orthographic camera projection without perspective depth scaling", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const mesh = createLayerForComposition("mesh", composition);
    const camera = createLayerForComposition("camera", composition);
    if (!camera.camera) throw new Error("Expected camera settings");
    camera.camera.projection = "orthographic";
    composition.layers = [mesh, camera];
    const scene = flattenSceneLayers(composition, project, 0);
    const baseCamera = {
      transform: evaluateWorldTransform(camera, composition, 0),
      settings: camera.camera,
    };
    const centered = buildSceneGeometry(composition, scene, baseCamera).data;
    mesh.transform.position[2] = { mode: "static", value: 600 };
    const depthMoved = buildSceneGeometry(
      composition,
      flattenSceneLayers(composition, project, 0),
      baseCamera,
    ).data;
    expect(depthMoved[0]).toBeCloseTo(centered[0]);
    expect(depthMoved[1]).toBeCloseTo(centered[1]);
    expect(depthMoved[2]).not.toBeCloseTo(centered[2]);
  });

  it("packs explicit vector kind, roundness, and stroke style attributes", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const ellipse = createLayerForComposition("shape", composition);
    ellipse.size = [480, 480];
    ellipse.shape = {
      kind: "ellipse",
      roundness: 24,
      strokeWidth: 12,
      strokeColor: [1, 0.5, 0.25, 0.8],
      fillMode: "radial",
      gradientColor: [0.1, 0.2, 0.8, 1],
      gradientAngle: 45,
      dashLength: 16,
      dashGap: 8,
      lineCap: "butt",
      lineJoin: "bevel",
    };
    composition.layers = [ellipse];
    const data = buildSceneGeometry(composition, flattenSceneLayers(composition, project, 0)).data;
    expect(data[VERTEX_FLOAT_OFFSETS.shapeStyleColor]).toBe(1);
    expect(data[VERTEX_FLOAT_OFFSETS.shapeStyleParameters]).toBeCloseTo(0.05);
    expect(data[VERTEX_FLOAT_OFFSETS.shapeStyleParameters + 1]).toBeCloseTo(0.05);
    expect(data[VERTEX_FLOAT_OFFSETS.shapeStyleParameters + 2]).toBe(2);
    expect(data[VERTEX_FLOAT_OFFSETS.gradientStyleColor + 2]).toBeCloseTo(0.8);
    expect(data[VERTEX_FLOAT_OFFSETS.gradientStyleParameters]).toBe(2);
    expect(data[VERTEX_FLOAT_OFFSETS.gradientStyleParameters + 1]).toBeCloseTo(Math.PI / 4);
  });

  it("tessellates Bezier paths into the shared GPU vertex stream", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const path = createLayerForComposition("shape", composition);
    if (!path.shape) throw new Error("Expected shape settings");
    path.size = [760, 480];
    path.shape.kind = "bezier";
    path.shape.path = createDefaultBezierPath();
    path.shape.strokeWidth = 12;
    path.shape.lineJoin = "round";
    composition.layers = [path];

    const geometry = buildSceneGeometry(composition, flattenSceneLayers(composition, project, 0));
    expect(geometry.batches[0].vertexCount).toBeGreaterThan(12);
    expect(geometry.data).toHaveLength(geometry.batches[0].vertexCount * FLOATS_PER_VERTEX);
    expect(geometry.data[VERTEX_FLOAT_OFFSETS.shapeStyleParameters + 2]).toBe(4);
    expect(Array.from(geometry.data).every(Number.isFinite)).toBe(true);

    path.shape.trim = { start: 0, end: 50, offset: 0 };
    const trimmed = buildSceneGeometry(composition, flattenSceneLayers(composition, project, 0));
    expect(trimmed.batches[0].vertexCount).toBeGreaterThan(0);
    expect(trimmed.batches[0].vertexCount).toBeLessThan(geometry.batches[0].vertexCount);
  });

  it("includes text quads so cached glyph textures share the layer effect graph", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const text = createLayerForComposition("text", composition);
    composition.layers = [text];
    const geometry = buildSceneGeometry(composition, flattenSceneLayers(composition, project, 0));
    expect(geometry.batches).toHaveLength(1);
    expect(geometry.batches[0].layer.kind).toBe("text");
    expect(geometry.data[VERTEX_FLOAT_OFFSETS.mediaType]).toBe(0);
  });

  it("sizes a 3D precomposition quad from its source composition", () => {
    const project = createBlankProject();
    const root = project.compositions[0];
    const nested = structuredClone(root);
    nested.id = crypto.randomUUID();
    nested.width = 320;
    nested.height = 160;
    const wrapper = createLayerForComposition("precomposition", root);
    wrapper.sourceCompositionId = nested.id;
    wrapper.threeDimensional = true;
    expect(wrapper.size).toEqual([720, 720]);
    root.layers = [wrapper];
    project.compositions.push(nested);

    const geometry = buildSceneGeometry(root, flattenSceneLayers(root, project, 0));
    expect(geometry.data[VERTEX_FLOAT_OFFSETS.position]).toBeCloseTo(-320 / root.width);
    expect(geometry.data[VERTEX_FLOAT_OFFSETS.position + 1]).toBeCloseTo(160 / root.height);
  });

  it("keeps clone effect instances distinct while sharing their media resource", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const image = createLayerForComposition("image", composition);
    image.cloner = {
      distribution: { kind: "grid", count: [3, 1, 1], spacing: [200, 0, 0] },
      effectors: [],
    };
    composition.layers = [image];

    const geometry = buildSceneGeometry(composition, flattenSceneLayers(composition, project, 0));
    expect(new Set(geometry.batches.map((batch) => batch.instanceId)).size).toBe(3);
    expect(new Set(geometry.batches.map((batch) => batch.selectionId))).toEqual(
      new Set([image.id]),
    );
    expect(new Set(geometry.batches.map((batch) => batch.resourceInstanceId))).toEqual(
      new Set([`root/${image.id}`]),
    );
  });

  it("expands imported indexed meshes into the shared GPU vertex stream", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const mesh = createLayerForComposition("mesh", composition);
    mesh.mesh = {
      name: "Triangle",
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
      uvs: [0, 0, 1, 0, 0, 1],
      indices: [0, 1, 2],
    };
    composition.layers = [mesh];

    const geometry = buildSceneGeometry(composition, flattenSceneLayers(composition, project, 0));
    expect(geometry.batches[0].vertexCount).toBe(3);
    expect(geometry.data).toHaveLength(FLOATS_PER_VERTEX * 3);
    expect(
      new Set([
        geometry.data[0],
        geometry.data[FLOATS_PER_VERTEX],
        geometry.data[FLOATS_PER_VERTEX * 2],
      ]).size,
    ).toBe(2);
  });
});

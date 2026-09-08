import { EvaluationCache, type EvaluationCacheStatistics } from "../animation/evaluation-cache";
import { evaluateAnimatable } from "../animation/timeline";
import type { Animatable, BezierPath, EffectMask, Id, Layer } from "../types";

export const SHAPE_GRAPH_LIMITS = {
  groups: 512,
  childrenPerGroup: 1024,
  instances: 4096,
  paths: 1024,
  verticesPerPath: 512,
  totalVertices: 65_536,
  depth: 64,
} as const;

export type ShapeMatrix = readonly [number, number, number, number, number, number];

export interface ShapeGroupTransform {
  position: [Animatable, Animatable];
  scale: [Animatable, Animatable];
  rotation: Animatable;
  opacity: Animatable;
}

export interface ShapePathResource {
  id: Id;
  revision: number;
  path: BezierPath;
}

export interface ShapePathInstance {
  kind: "path";
  id: Id;
  pathId: Id;
  visible: boolean;
  transform?: ShapeGroupTransform;
}

export interface ShapeGroupReference {
  kind: "group";
  id: Id;
  groupId: Id;
}

export interface ShapeGroup {
  id: Id;
  name: string;
  visible: boolean;
  transform: ShapeGroupTransform;
  children: Array<ShapePathInstance | ShapeGroupReference>;
}

export interface ShapeGraph {
  id: Id;
  /** Increment whenever graph structure, transforms, or path resources change. */
  revision: number;
  paths: ShapePathResource[];
  groups: ShapeGroup[];
  rootGroupIds: Id[];
}

export interface FlattenedShapePath {
  instanceId: Id;
  pathId: Id;
  /** Shared immutable-by-contract resource; masks and instances reuse this object. */
  path: BezierPath;
  matrix: ShapeMatrix;
  opacity: number;
}

export interface ResolvedMaskPath {
  effectId: Id;
  pathId: Id;
  /** The exact same resource object exposed by matching flattened shape instances. */
  path: BezierPath;
  opacity: number;
  feather: number;
  invert: boolean;
}

export interface EvaluatedShapeGraph {
  shapes: readonly FlattenedShapePath[];
  masks: readonly ResolvedMaskPath[];
}

export interface ShapeEvaluationCacheOptions {
  capacity?: number;
  maxBytes?: number;
}

const IDENTITY_MATRIX: ShapeMatrix = [1, 0, 0, 1, 0, 0];

export class ShapeEvaluationCache {
  readonly #cache: EvaluationCache<EvaluatedShapeGraph>;

  constructor(options: ShapeEvaluationCacheOptions = {}) {
    this.#cache = new EvaluationCache({
      capacity: options.capacity ?? 64,
      maxBytes: options.maxBytes ?? 16 * 1024 * 1024,
      sizeOf: estimateEvaluationBytes,
    });
  }

  evaluate(layer: Layer, time: number): EvaluatedShapeGraph {
    const graph = layer.shapeGraph;
    if (!graph) return { shapes: [], masks: [] };
    validateShapeGraph(graph);
    if (!Number.isFinite(time)) throw new Error("Shape graph evaluation time must be finite");
    const key = { nodeId: graph.id, revision: graph.revision, time };
    const cached = this.#cache.get(key);
    if (cached) return cached;
    const value = evaluateShapeGraph(layer, graph, time);
    this.#cache.set(key, value);
    return value;
  }

  invalidate(graphId: Id): number {
    return this.#cache.invalidateNode(graphId);
  }

  statistics(): EvaluationCacheStatistics {
    return this.#cache.statistics();
  }
}

export function flattenShapeGraph(graph: ShapeGraph, time: number): readonly FlattenedShapePath[] {
  validateShapeGraph(graph);
  if (!Number.isFinite(time)) throw new Error("Shape graph evaluation time must be finite");
  const groups = new Map(graph.groups.map((group) => [group.id, group]));
  const paths = new Map(graph.paths.map((resource) => [resource.id, resource.path]));
  const output: FlattenedShapePath[] = [];

  const visit = (
    groupId: Id,
    parentMatrix: ShapeMatrix,
    parentOpacity: number,
    stack: ReadonlySet<Id>,
    depth: number,
  ): void => {
    if (output.length >= SHAPE_GRAPH_LIMITS.instances || depth > SHAPE_GRAPH_LIMITS.depth) return;
    if (stack.has(groupId)) return;
    const group = groups.get(groupId);
    if (!group?.visible) return;
    const nextStack = new Set(stack).add(groupId);
    const evaluated = evaluateTransform(group.transform, time);
    const matrix = multiplyMatrix(parentMatrix, evaluated.matrix);
    const opacity = parentOpacity * evaluated.opacity;
    for (const child of group.children) {
      if (output.length >= SHAPE_GRAPH_LIMITS.instances) break;
      if (child.kind === "group") {
        visit(child.groupId, matrix, opacity, nextStack, depth + 1);
        continue;
      }
      if (!child.visible) continue;
      const path = paths.get(child.pathId);
      if (!path) continue;
      const childTransform = child.transform
        ? evaluateTransform(child.transform, time)
        : { matrix: IDENTITY_MATRIX, opacity: 1 };
      output.push({
        instanceId: child.id,
        pathId: child.pathId,
        path,
        matrix: multiplyMatrix(matrix, childTransform.matrix),
        opacity: opacity * childTransform.opacity,
      });
    }
  };

  for (const rootId of graph.rootGroupIds) {
    if (output.length >= SHAPE_GRAPH_LIMITS.instances) break;
    visit(rootId, IDENTITY_MATRIX, 1, new Set(), 1);
  }
  return output;
}

export function resolveMaskPathReferences(
  layer: Layer,
  graph: ShapeGraph,
): readonly ResolvedMaskPath[] {
  const paths = new Map(graph.paths.map((resource) => [resource.id, resource.path]));
  const output: ResolvedMaskPath[] = [];
  for (const effect of layer.effects) {
    const mask = effect.mask;
    if (mask?.shape !== "path" || !mask.pathId) continue;
    const path = paths.get(mask.pathId);
    if (!path) continue;
    output.push(maskReference(effect.id, mask, path));
  }
  return output;
}

export function validateShapeGraph(
  value: unknown,
  location = "shape graph",
): asserts value is ShapeGraph {
  const graph = object(value, location);
  string(graph.id, `${location}.id`);
  integer(graph.revision, `${location}.revision`, 0, Number.MAX_SAFE_INTEGER);
  const paths = array(graph.paths, `${location}.paths`, SHAPE_GRAPH_LIMITS.paths);
  const groups = array(graph.groups, `${location}.groups`, SHAPE_GRAPH_LIMITS.groups);
  const roots = array(graph.rootGroupIds, `${location}.rootGroupIds`, SHAPE_GRAPH_LIMITS.groups);
  const pathIds = new Set<string>();
  let totalVertices = 0;
  for (const [index, candidate] of paths.entries()) {
    const path = object(candidate, `${location}.paths[${index}]`);
    const id = uniqueId(path.id, pathIds, `${location}.paths[${index}].id`);
    integer(path.revision, `${location}.paths[${index}].revision`, 0, Number.MAX_SAFE_INTEGER);
    totalVertices += validatePath(path.path, `${location}.paths[${index}].path`);
    if (totalVertices > SHAPE_GRAPH_LIMITS.totalVertices)
      throw new Error(`${location} exceeds the total vertex limit`);
    pathIds.add(id);
  }
  const groupIds = new Set<string>();
  const groupObjects = new Map<string, Record<string, unknown>>();
  const instanceIds = new Set<string>();
  for (const [index, candidate] of groups.entries()) {
    const group = object(candidate, `${location}.groups[${index}]`);
    const id = uniqueId(group.id, groupIds, `${location}.groups[${index}].id`);
    groupIds.add(id);
    groupObjects.set(id, group);
    string(group.name, `${location}.groups[${index}].name`);
    boolean(group.visible, `${location}.groups[${index}].visible`);
    validateTransform(group.transform, `${location}.groups[${index}].transform`);
    array(
      group.children,
      `${location}.groups[${index}].children`,
      SHAPE_GRAPH_LIMITS.childrenPerGroup,
    );
  }
  for (const [groupId, group] of groupObjects) {
    for (const [index, candidate] of (group.children as unknown[]).entries()) {
      const itemLocation = `${location}.groups.${groupId}.children[${index}]`;
      const child = object(candidate, itemLocation);
      uniqueId(child.id, instanceIds, `${itemLocation}.id`);
      instanceIds.add(child.id as string);
      if (instanceIds.size > SHAPE_GRAPH_LIMITS.instances)
        throw new Error(`${location} exceeds the shape instance limit`);
      if (child.kind === "group") {
        if (!groupIds.has(string(child.groupId, `${itemLocation}.groupId`)))
          throw new Error(`${itemLocation} references a missing group`);
      } else if (child.kind === "path") {
        if (!pathIds.has(string(child.pathId, `${itemLocation}.pathId`)))
          throw new Error(`${itemLocation} references a missing path`);
        boolean(child.visible, `${itemLocation}.visible`);
        if (child.transform !== undefined)
          validateTransform(child.transform, `${itemLocation}.transform`);
      } else throw new Error(`${itemLocation}.kind must be group or path`);
    }
  }
  const rootIds = new Set<string>();
  for (const [index, candidate] of roots.entries()) {
    const id = uniqueId(candidate, rootIds, `${location}.rootGroupIds[${index}]`);
    if (!groupIds.has(id)) throw new Error(`${location}.rootGroupIds references a missing group`);
    rootIds.add(id);
  }
  detectCycles(groupObjects, location);
}

function evaluateShapeGraph(layer: Layer, graph: ShapeGraph, time: number): EvaluatedShapeGraph {
  return {
    shapes: flattenShapeGraph(graph, time),
    masks: resolveMaskPathReferences(layer, graph),
  };
}

function evaluateTransform(
  transform: ShapeGroupTransform,
  time: number,
): { matrix: ShapeMatrix; opacity: number } {
  const x = evaluateAnimatable(transform.position[0], time);
  const y = evaluateAnimatable(transform.position[1], time);
  const scaleX = evaluateAnimatable(transform.scale[0], time) / 100;
  const scaleY = evaluateAnimatable(transform.scale[1], time) / 100;
  const radians = (evaluateAnimatable(transform.rotation, time) * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    matrix: [cosine * scaleX, sine * scaleX, -sine * scaleY, cosine * scaleY, x, y],
    opacity: Math.max(0, Math.min(1, evaluateAnimatable(transform.opacity, time) / 100)),
  };
}

function multiplyMatrix(left: ShapeMatrix, right: ShapeMatrix): ShapeMatrix {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

function maskReference(effectId: Id, mask: EffectMask, path: BezierPath): ResolvedMaskPath {
  return {
    effectId,
    pathId: mask.pathId as Id,
    path,
    opacity: finite(mask.opacity) ? Math.max(0, Math.min(1, mask.opacity / 100)) : 1,
    feather: finite(mask.feather) ? Math.max(0, Math.min(1_000_000, mask.feather)) : 0,
    invert: mask.invert,
  };
}

function estimateEvaluationBytes(value: EvaluatedShapeGraph): number {
  const uniquePaths = new Set(value.shapes.map((shape) => shape.path));
  for (const mask of value.masks) uniquePaths.add(mask.path);
  let bytes = value.shapes.length * 96 + value.masks.length * 64;
  for (const path of uniquePaths) bytes += 16 + path.vertices.length * 48;
  return bytes;
}

function detectCycles(groups: Map<string, Record<string, unknown>>, location: string): void {
  const complete = new Set<string>();
  const visit = (id: string, stack: Set<string>, depth: number): void => {
    if (complete.has(id)) return;
    if (stack.has(id)) throw new Error(`${location} contains a group cycle at ${id}`);
    if (depth > SHAPE_GRAPH_LIMITS.depth) throw new Error(`${location} exceeds the depth limit`);
    const next = new Set(stack).add(id);
    const group = groups.get(id);
    for (const child of (group?.children as Array<Record<string, unknown>>) ?? [])
      if (child.kind === "group") visit(child.groupId as string, next, depth + 1);
    complete.add(id);
  };
  for (const id of groups.keys()) visit(id, new Set(), 1);
}

function validatePath(value: unknown, location: string): number {
  const path = object(value, location);
  boolean(path.closed, `${location}.closed`);
  const vertices = array(path.vertices, `${location}.vertices`, SHAPE_GRAPH_LIMITS.verticesPerPath);
  if (vertices.length < 2)
    throw new Error(`${location}.vertices must contain at least two anchors`);
  for (const [index, candidate] of vertices.entries()) {
    const vertex = object(candidate, `${location}.vertices[${index}]`);
    for (const field of ["position", "inTangent", "outTangent"] as const) {
      const point = array(vertex[field], `${location}.vertices[${index}].${field}`, 2);
      if (point.length !== 2 || point.some((channel) => !finite(channel)))
        throw new Error(`${location}.vertices[${index}].${field} must contain two finite values`);
    }
  }
  return vertices.length;
}

function validateTransform(value: unknown, location: string): void {
  const transform = object(value, location);
  const position = array(transform.position, `${location}.position`, 2);
  const scale = array(transform.scale, `${location}.scale`, 2);
  if (position.length !== 2 || scale.length !== 2)
    throw new Error(`${location} position and scale must contain two properties`);
  for (const [index, property] of [
    ...position,
    ...scale,
    transform.rotation,
    transform.opacity,
  ].entries())
    validateAnimatable(property, `${location}.properties[${index}]`);
}

function validateAnimatable(value: unknown, location: string): void {
  const property = object(value, location);
  if (property.mode === "static") {
    if (!finite(property.value)) throw new Error(`${location}.value must be finite`);
    return;
  }
  if (property.mode !== "animated") throw new Error(`${location}.mode is invalid`);
  const keyframes = array(property.keyframes, `${location}.keyframes`, 10_000);
  let previous = -Infinity;
  for (const [index, candidate] of keyframes.entries()) {
    const keyframe = object(candidate, `${location}.keyframes[${index}]`);
    string(keyframe.id, `${location}.keyframes[${index}].id`);
    const time = finiteNumber(keyframe.time, `${location}.keyframes[${index}].time`);
    finiteNumber(keyframe.value, `${location}.keyframes[${index}].value`);
    if (!["linear", "step", "bezier"].includes(String(keyframe.interpolation)))
      throw new Error(`${location}.keyframes[${index}].interpolation is invalid`);
    if (keyframe.easing !== undefined) {
      const easing = array(keyframe.easing, `${location}.keyframes[${index}].easing`, 4);
      if (easing.length !== 4 || easing.some((channel) => !finite(channel)))
        throw new Error(`${location}.keyframes[${index}].easing must contain four finite values`);
    }
    for (const field of ["spatialIn", "spatialOut"] as const)
      if (keyframe[field] !== undefined)
        finiteNumber(keyframe[field], `${location}.keyframes[${index}].${field}`);
    if (time <= previous) throw new Error(`${location}.keyframes must be strictly sorted`);
    previous = time;
  }
}

function object(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${location} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, location: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum)
    throw new Error(`${location} must be an array with at most ${maximum} items`);
  return value;
}

function string(value: unknown, location: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256)
    throw new Error(`${location} must be a non-empty bounded string`);
  return value;
}

function boolean(value: unknown, location: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${location} must be a boolean`);
  return value;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function finiteNumber(value: unknown, location: string): number {
  if (!finite(value)) throw new Error(`${location} must be finite`);
  return value;
}

function integer(value: unknown, location: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
    throw new Error(`${location} must be a bounded integer`);
  return value as number;
}

function uniqueId(value: unknown, existing: ReadonlySet<string>, location: string): string {
  const id = string(value, location);
  if (existing.has(id)) throw new Error(`${location} is duplicated`);
  return id;
}

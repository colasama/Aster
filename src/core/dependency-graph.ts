import type { Id } from "./types";

export type DependencyNodeKind = "property" | "effect" | "layer" | "composition";

export interface DependencyNode {
  id: Id;
  kind: DependencyNodeKind;
  ownerId: Id;
  label: string;
}

export class DependencyGraph {
  readonly #dependents = new Map<Id, Set<Id>>();
  readonly #dependencies = new Map<Id, Set<Id>>();
  readonly #dirty = new Set<Id>();
  readonly #nodes = new Map<Id, DependencyNode>();
  #topologicalCache?: Id[];

  addNode(id: Id, node?: Omit<DependencyNode, "id">): void {
    if (!this.#dependencies.has(id)) this.#topologicalCache = undefined;
    if (!this.#dependents.has(id)) this.#dependents.set(id, new Set());
    if (!this.#dependencies.has(id)) this.#dependencies.set(id, new Set());
    if (node) this.#nodes.set(id, { id, ...node });
  }

  addDependency(node: Id, dependency: Id): void {
    this.addNode(node);
    this.addNode(dependency);
    if (node === dependency || this.#reaches(node, dependency)) {
      throw new Error("Dependency would create a cycle");
    }
    this.#dependencies.get(node)?.add(dependency);
    this.#dependents.get(dependency)?.add(node);
    this.#topologicalCache = undefined;
  }

  markDirty(root: Id): number {
    const queue = [root];
    const visited = new Set<Id>();
    while (queue.length > 0) {
      const node = queue.shift();
      if (!node || visited.has(node)) continue;
      visited.add(node);
      this.#dirty.add(node);
      queue.push(...(this.#dependents.get(node) ?? []));
    }
    return visited.size;
  }

  consumeDirtyOrder(): Id[] {
    const order = this.#topologicalCache ?? this.#createTopologicalOrder();
    this.#topologicalCache = order;
    return order.filter((node) => this.#dirty.delete(node));
  }

  node(id: Id): DependencyNode | undefined {
    return this.#nodes.get(id);
  }

  nodes(kind?: DependencyNodeKind): DependencyNode[] {
    const nodes = [...this.#nodes.values()];
    return kind ? nodes.filter((node) => node.kind === kind) : nodes;
  }

  get size(): number {
    return this.#dependencies.size;
  }

  #createTopologicalOrder(): Id[] {
    const pending = new Map([...this.#dependencies].map(([id, entries]) => [id, entries.size]));
    const queue = [...pending].filter(([, count]) => count === 0).map(([id]) => id);
    const order: Id[] = [];
    while (queue.length > 0) {
      const node = queue.shift();
      if (!node) continue;
      order.push(node);
      for (const dependent of this.#dependents.get(node) ?? []) {
        const count = (pending.get(dependent) ?? 1) - 1;
        pending.set(dependent, count);
        if (count === 0) queue.push(dependent);
      }
    }
    if ([...pending.values()].some((count) => count > 0))
      throw new Error("Dependency graph contains a cycle");
    return order;
  }

  #reaches(start: Id, target: Id): boolean {
    const queue = [start];
    const visited = new Set<Id>();
    while (queue.length > 0) {
      const node = queue.shift();
      if (!node) continue;
      if (node === target) return true;
      if (visited.has(node)) continue;
      visited.add(node);
      queue.push(...(this.#dependents.get(node) ?? []));
    }
    return false;
  }
}

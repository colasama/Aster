import type { Id } from "./types";

export class DependencyGraph {
  readonly #dependents = new Map<Id, Set<Id>>();
  readonly #dependencies = new Map<Id, Set<Id>>();
  readonly #dirty = new Set<Id>();

  addNode(id: Id): void {
    if (!this.#dependents.has(id)) this.#dependents.set(id, new Set());
    if (!this.#dependencies.has(id)) this.#dependencies.set(id, new Set());
  }

  addDependency(node: Id, dependency: Id): void {
    this.addNode(node);
    this.addNode(dependency);
    if (node === dependency || this.#reaches(node, dependency)) {
      throw new Error("Dependency would create a cycle");
    }
    this.#dependencies.get(node)?.add(dependency);
    this.#dependents.get(dependency)?.add(node);
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
    const pending = new Map([...this.#dependencies].map(([id, entries]) => [id, entries.size]));
    const queue = [...pending].filter(([, count]) => count === 0).map(([id]) => id);
    const order: Id[] = [];
    while (queue.length > 0) {
      const node = queue.shift();
      if (!node) continue;
      if (this.#dirty.delete(node)) order.push(node);
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

  get size(): number {
    return this.#dependencies.size;
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

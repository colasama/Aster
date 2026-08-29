import {
  createDiagnostic,
  type DiagnosticInput,
  type DiagnosticSeverity,
  diagnosticFingerprint,
  type EditorDiagnostic,
  severityRank,
} from "./diagnostic";

export const MAX_DIAGNOSTICS = 200;

export type DiagnosticActionHandler = () => void | Promise<void>;

export interface ReportDiagnosticOptions {
  actionHandlers?: Readonly<Record<string, DiagnosticActionHandler>>;
  now?: Date;
}

export class DiagnosticStore {
  #diagnostics: EditorDiagnostic[] = [];
  #handlers = new Map<string, Readonly<Record<string, DiagnosticActionHandler>>>();
  #listeners = new Set<() => void>();
  #snapshot: readonly EditorDiagnostic[] = Object.freeze([]);

  snapshot = (): readonly EditorDiagnostic[] => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  report(input: DiagnosticInput, options: ReportDiagnosticOptions = {}): EditorDiagnostic {
    const candidate = createDiagnostic(input, options.now);
    const fingerprint = diagnosticFingerprint(candidate);
    const duplicateIndex = this.#diagnostics.findIndex(
      (diagnostic) =>
        diagnostic.status === "active" && diagnosticFingerprint(diagnostic) === fingerprint,
    );
    if (duplicateIndex >= 0) {
      const current = this.#diagnostics[duplicateIndex] as EditorDiagnostic;
      const merged: EditorDiagnostic = {
        ...current,
        correlationId: candidate.correlationId,
        severity:
          severityRank(candidate.severity) > severityRank(current.severity)
            ? candidate.severity
            : current.severity,
        actions: candidate.actions.length > 0 ? candidate.actions : current.actions,
        ...(candidate.details ? { details: candidate.details } : {}),
        lastSeenAt: candidate.lastSeenAt,
        occurrences: current.occurrences + 1,
        persistent: current.persistent || candidate.persistent,
      };
      this.#diagnostics.splice(duplicateIndex, 1, merged);
      if (options.actionHandlers) this.#handlers.set(merged.id, options.actionHandlers);
      this.#publish();
      return merged;
    }
    this.#diagnostics.push(candidate);
    if (options.actionHandlers) this.#handlers.set(candidate.id, options.actionHandlers);
    this.#enforceCapacity();
    this.#publish();
    return candidate;
  }

  resolve(id: string): void {
    this.#transition(id, "resolved");
  }

  dismiss(id: string): void {
    const diagnostic = this.#diagnostics.find((candidate) => candidate.id === id);
    if (!diagnostic || diagnostic.persistent || diagnostic.status !== "active") return;
    this.#transition(id, "dismissed");
  }

  clearInactive(): void {
    const active = this.#diagnostics.filter((diagnostic) => diagnostic.status === "active");
    if (active.length === this.#diagnostics.length) return;
    const activeIds = new Set(active.map((diagnostic) => diagnostic.id));
    for (const id of this.#handlers.keys()) if (!activeIds.has(id)) this.#handlers.delete(id);
    this.#diagnostics = active;
    this.#publish();
  }

  async invokeAction(diagnosticId: string, actionId: string): Promise<boolean> {
    const diagnostic = this.#diagnostics.find(
      (candidate) => candidate.id === diagnosticId && candidate.status === "active",
    );
    if (!diagnostic?.actions.some((action) => action.id === actionId)) return false;
    const handler = this.#handlers.get(diagnosticId)?.[actionId];
    if (!handler) return false;
    await handler();
    return true;
  }

  adjacent(
    currentId: string | undefined,
    direction: 1 | -1,
    minimumSeverity: DiagnosticSeverity = "info",
  ): EditorDiagnostic | undefined {
    const candidates = this.#diagnostics.filter(
      (diagnostic) =>
        diagnostic.status === "active" &&
        severityRank(diagnostic.severity) >= severityRank(minimumSeverity),
    );
    if (candidates.length === 0) return undefined;
    const currentIndex = candidates.findIndex((diagnostic) => diagnostic.id === currentId);
    const index =
      currentIndex < 0
        ? direction > 0
          ? 0
          : candidates.length - 1
        : (currentIndex + direction + candidates.length) % candidates.length;
    return candidates[index];
  }

  #transition(id: string, status: "resolved" | "dismissed"): void {
    const index = this.#diagnostics.findIndex((diagnostic) => diagnostic.id === id);
    const current = this.#diagnostics[index];
    if (current?.status !== "active") return;
    this.#diagnostics.splice(index, 1, { ...current, status });
    this.#handlers.delete(id);
    this.#publish();
  }

  #enforceCapacity(): void {
    while (this.#diagnostics.length > MAX_DIAGNOSTICS) {
      let discardIndex = this.#diagnostics.findIndex(
        (diagnostic) => diagnostic.status !== "active",
      );
      if (discardIndex < 0) {
        discardIndex = 0;
        for (let index = 1; index < this.#diagnostics.length; index += 1) {
          const candidate = this.#diagnostics[index] as EditorDiagnostic;
          const discard = this.#diagnostics[discardIndex] as EditorDiagnostic;
          if (severityRank(candidate.severity) < severityRank(discard.severity))
            discardIndex = index;
        }
      }
      const [discarded] = this.#diagnostics.splice(discardIndex, 1);
      if (discarded) this.#handlers.delete(discarded.id);
    }
  }

  #publish(): void {
    this.#snapshot = Object.freeze(
      this.#diagnostics.map((diagnostic) => Object.freeze(diagnostic)),
    );
    for (const listener of this.#listeners) listener();
  }
}

export const diagnosticStore = new DiagnosticStore();

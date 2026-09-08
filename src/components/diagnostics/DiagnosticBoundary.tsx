import { Component, type ErrorInfo, type ReactNode, useEffect } from "react";
import { type DiagnosticStore, diagnosticStore } from "../../errors/diagnostic-store";
import { useI18n } from "../../i18n/react";

interface DiagnosticBoundaryCopy {
  title: string;
  message: string;
  retry: string;
  details: string;
  copy: string;
}

interface BoundaryProps {
  children: ReactNode;
  copy: DiagnosticBoundaryCopy;
  store: DiagnosticStore;
}

interface BoundaryState {
  error?: Error;
  diagnosticId?: string;
}

export class DiagnosticErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = {};

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error: asError(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const detailed = Object.assign(new Error(error.message), {
      cause: new Error(info.componentStack ?? "React component stack unavailable"),
    });
    detailed.name = error.name;
    detailed.stack = error.stack;
    const diagnostic = this.props.store.report(
      {
        code: "react_render_failed",
        title: this.props.copy.title,
        message: error.message || this.props.copy.message,
        severity: "fatal",
        persistent: true,
        scope: { area: "application" },
        error: detailed,
        actions: [
          { id: "retry", kind: "retry", label: this.props.copy.retry },
          { id: "details", kind: "details", label: this.props.copy.details },
          { id: "copy", kind: "copy", label: this.props.copy.copy },
        ],
      },
      { actionHandlers: { retry: () => this.retry() } },
    );
    this.setState({ diagnosticId: diagnostic.id });
  }

  retry = (): void => {
    if (this.state.diagnosticId) this.props.store.resolve(this.state.diagnosticId);
    this.setState({ error: undefined, diagnosticId: undefined });
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main className="diagnostic-fatal-fallback" role="alert">
        <strong>{this.props.copy.title}</strong>
        <span>{this.state.error.message || this.props.copy.message}</span>
        <button onClick={this.retry} type="button">
          {this.props.copy.retry}
        </button>
      </main>
    );
  }
}

export function DiagnosticRuntimeMonitor({ store = diagnosticStore }: { store?: DiagnosticStore }) {
  const { t } = useI18n();
  useEffect(() => {
    const report = (error: unknown) => {
      const normalized = asError(error);
      if (normalized.name === "AbortError") return;
      store.report({
        code: "unhandled_runtime_error",
        title: t("diagnostic.runtimeTitle"),
        message: normalized.message,
        severity: "error",
        scope: { area: "application" },
        error: normalized,
        actions: [
          { id: "details", kind: "details", label: t("diagnostic.details") },
          { id: "copy", kind: "copy", label: t("diagnostic.copy") },
        ],
      });
    };
    const onError = (event: ErrorEvent) => report(event.error ?? event.message);
    const onRejection = (event: PromiseRejectionEvent) => report(event.reason);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [store, t]);
  return null;
}

export function ApplicationDiagnosticBoundary({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const copy: DiagnosticBoundaryCopy = {
    title: t("diagnostic.renderTitle"),
    message: t("diagnostic.renderMessage"),
    retry: t("diagnostic.retry"),
    details: t("diagnostic.details"),
    copy: t("diagnostic.copy"),
  };
  return (
    <DiagnosticErrorBoundary copy={copy} store={diagnosticStore}>
      {children}
    </DiagnosticErrorBoundary>
  );
}

function asError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string") return new Error(value);
  try {
    return new Error(JSON.stringify(value));
  } catch {
    return new Error(String(value));
  }
}

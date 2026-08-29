import { Maximize2, Minimize2 } from "lucide-react";
import {
  type CSSProperties,
  type PropsWithChildren,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n/react";
import { useWorkspacePanelHost } from "./workspace/WorkspacePanelHost";

let topPanelZIndex = 20;

interface PanelProps extends PropsWithChildren {
  title?: string;
  className?: string;
  tabs?: ReactNode;
  actions?: ReactNode;
}

export function Panel({ title, className = "", tabs, actions, children }: PanelProps) {
  const { t } = useI18n();
  const workspaceHost = useWorkspacePanelHost();
  const panelRef = useRef<HTMLElement>(null);
  const drag = useRef({ active: false, x: 0, y: 0, left: 0, top: 0, width: 0, height: 0 });
  const [floating, setFloating] = useState(false);
  const [rect, setRect] = useState({ left: 120, top: 90, width: 620, height: 420 });
  const [zIndex, setZIndex] = useState(1);
  useEffect(() => {
    const panel = panelRef.current;
    if (!floating || !panel) return;
    const observer = new ResizeObserver(() => {
      if (drag.current.active) return;
      const { width, height } = panel.getBoundingClientRect();
      setRect((current) =>
        Math.abs(current.width - width) < 0.5 && Math.abs(current.height - height) < 0.5
          ? current
          : { ...current, width, height },
      );
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, [floating]);
  const toggleFloating = () => {
    if (!floating) {
      const bounds = panelRef.current?.getBoundingClientRect();
      if (bounds) {
        setRect({
          left: Math.max(8, bounds.left),
          top: Math.max(40, bounds.top),
          width: Math.max(300, bounds.width),
          height: Math.max(180, bounds.height),
        });
      }
      topPanelZIndex += 1;
      setZIndex(topPanelZIndex);
    }
    setFloating(!floating);
  };
  const floatingStyle: CSSProperties | undefined = floating ? { ...rect, zIndex } : undefined;
  const embedded = workspaceHost !== null;
  const embeddedHeader =
    embedded && workspaceHost.headerHost && (tabs || actions)
      ? createPortal(
          <>
            {tabs}
            {actions ? <div className="panel-actions">{actions}</div> : null}
          </>,
          workspaceHost.headerHost,
        )
      : null;
  return (
    <>
      {embeddedHeader}
      <section
        className={`panel ${className} ${!embedded && floating ? "floating" : "docked"} ${embedded ? "workspace-embedded-panel" : ""}`}
        onPointerDown={() => {
          if (!embedded && floating) {
            topPanelZIndex += 1;
            setZIndex(topPanelZIndex);
          }
        }}
        ref={panelRef}
        style={embedded ? undefined : floatingStyle}
      >
        {!embedded && (title || tabs || actions) && (
          // biome-ignore lint/a11y/noStaticElementInteractions: Floating panel headers implement pointer-based window dragging.
          <header
            className="panel-header"
            onDoubleClick={(event) => {
              if (!(event.target as HTMLElement).closest("button")) toggleFloating();
            }}
            onPointerDown={(event) => {
              if (!floating || (event.target as HTMLElement).closest("button, input")) return;
              const bounds = panelRef.current?.getBoundingClientRect();
              if (!bounds) return;
              drag.current = {
                active: true,
                x: event.clientX,
                y: event.clientY,
                left: bounds.left,
                top: bounds.top,
                width: bounds.width,
                height: bounds.height,
              };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (!drag.current.active) return;
              setRect({
                left: Math.max(
                  0,
                  Math.min(
                    window.innerWidth - 80,
                    drag.current.left + event.clientX - drag.current.x,
                  ),
                ),
                top: Math.max(
                  31,
                  Math.min(
                    window.innerHeight - 40,
                    drag.current.top + event.clientY - drag.current.y,
                  ),
                ),
                width: drag.current.width,
                height: drag.current.height,
              });
            }}
            onPointerUp={(event) => {
              if (!drag.current.active) return;
              drag.current.active = false;
              event.currentTarget.releasePointerCapture(event.pointerId);
            }}
          >
            {tabs ?? <span className="panel-title">{title}</span>}
            <div className="panel-actions">
              {actions}
              <button
                aria-label={floating ? t("panel.dock") : t("panel.float")}
                onClick={toggleFloating}
                title={floating ? t("panel.dock") : t("panel.floatHint")}
                type="button"
              >
                {floating ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
              </button>
            </div>
          </header>
        )}
        <div className="panel-content">{children}</div>
      </section>
    </>
  );
}

export function PanelTabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: string; label: string }[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="panel-tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          className={tab.id === active ? "active" : ""}
          key={tab.id}
          onClick={() => onChange(tab.id)}
          aria-selected={tab.id === active}
          role="tab"
          type="button"
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

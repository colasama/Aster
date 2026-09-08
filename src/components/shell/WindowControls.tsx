import { useEffect, useState } from "react";
import { useI18n } from "../../i18n/react";

export function WindowControls() {
  const { t } = useI18n();
  const controls = window.asterDesktop?.windowControls;
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!controls) return;
    let mounted = true;
    void controls
      .isMaximized()
      .then((nextMaximized) => {
        if (mounted) setMaximized(nextMaximized);
      })
      .catch(() => undefined);
    const stopListening = controls.onMaximizedChange(setMaximized);
    return () => {
      mounted = false;
      stopListening();
    };
  }, [controls]);

  if (!controls) return null;

  return (
    <div className="window-controls" data-platform={controls.platform}>
      <button
        aria-label={t("topbar.window.minimize")}
        className="window-control"
        onClick={() => void controls.minimize()}
        title={t("topbar.window.minimize")}
        type="button"
      >
        <span aria-hidden="true" className="window-glyph window-glyph-minimize" />
      </button>
      <button
        aria-label={maximized ? t("topbar.window.restore") : t("topbar.window.maximize")}
        className="window-control"
        onClick={() => {
          void controls
            .toggleMaximize()
            .then(setMaximized)
            .catch(() => undefined);
        }}
        title={maximized ? t("topbar.window.restore") : t("topbar.window.maximize")}
        type="button"
      >
        <span
          aria-hidden="true"
          className={`window-glyph ${maximized ? "window-glyph-restore" : "window-glyph-maximize"}`}
        />
      </button>
      <button
        aria-label={t("topbar.window.close")}
        className="window-control window-control-close"
        onClick={() => void controls.close()}
        title={t("topbar.window.close")}
        type="button"
      >
        <span aria-hidden="true" className="window-glyph window-glyph-close" />
      </button>
    </div>
  );
}

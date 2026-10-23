import ReactDOM from "react-dom/client";
import App from "./App";
import { installGlobalErrorLogging, logger } from "./core/logger";
import { applyBrowserUiScale } from "./ui/browser-ui-scale";
import { applyReducedMotionPreference } from "./ui/reduced-motion";
import { applyThemeColors, readThemeColors } from "./ui/theme-dom";
import { parseUiScale } from "./ui/ui-scale";

installGlobalErrorLogging();
logger.info("application", "renderer_started", { mode: import.meta.env.MODE });
applyReducedMotionPreference();
applyThemeColors(readThemeColors());
if (!window.asterDesktop)
  applyBrowserUiScale(parseUiScale(window.localStorage.getItem("aster.uiScale")));

const renderHost = new URLSearchParams(window.location.search).get("asterRenderHost") === "1";
const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
if (renderHost) {
  if (__ASTER_TS_REFERENCE__) {
    void import("./components/render-host/RenderHost").then(({ RenderHost }) =>
      root.render(<RenderHost />),
    );
  } else throw new Error("The TS render host is available only in reference builds");
} else root.render(<App />);

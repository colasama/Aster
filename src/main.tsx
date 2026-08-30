import ReactDOM from "react-dom/client";
import App from "./App";
import { RenderHost } from "./components/render-host/RenderHost";
import { installGlobalErrorLogging, logger } from "./core/logger";
import { applyBrowserUiScale } from "./ui/browser-ui-scale";
import { applyReducedMotionPreference } from "./ui/reduced-motion";
import { parseUiScale } from "./ui/ui-scale";

installGlobalErrorLogging();
logger.info("application", "renderer_started", { mode: import.meta.env.MODE });
applyReducedMotionPreference();
if (!window.asterDesktop)
  applyBrowserUiScale(parseUiScale(window.localStorage.getItem("aster.uiScale")));

const renderHost = new URLSearchParams(window.location.search).get("asterRenderHost") === "1";
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  renderHost ? <RenderHost /> : <App />,
);

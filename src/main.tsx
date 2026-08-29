import ReactDOM from "react-dom/client";
import App from "./App";
import { installGlobalErrorLogging, logger } from "./core/logger";
import { applyBrowserUiScale } from "./ui/browser-ui-scale";
import { parseUiScale } from "./ui/ui-scale";

installGlobalErrorLogging();
logger.info("application", "renderer_started", { mode: import.meta.env.MODE });
if (!window.asterDesktop)
  applyBrowserUiScale(parseUiScale(window.localStorage.getItem("aster.uiScale")));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);

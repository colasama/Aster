import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installGlobalErrorLogging, logger } from "./core/logger";

installGlobalErrorLogging();
logger.info("application", "renderer_started", { mode: import.meta.env.MODE });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

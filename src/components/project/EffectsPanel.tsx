import { Search } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../i18n/react";
import { Panel } from "../Panel";
import { EffectBrowser } from "./EffectBrowser";

export function EffectsPanel() {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  return (
    <Panel className="project-panel effects-panel" title={t("workspace.panel.effects")}>
      <div className="panel-search">
        <Search size={13} />
        <input
          aria-label={t("project.search")}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("project.search")}
          value={query}
        />
      </div>
      <EffectBrowser query={query} />
    </Panel>
  );
}

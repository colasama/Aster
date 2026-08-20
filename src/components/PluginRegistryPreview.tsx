import { FlaskConical, LockKeyhole, Puzzle } from "lucide-react";
import { filterRegistryEntries, type PluginRegistryCatalog } from "../core/plugin-catalog";
import { useI18n } from "../i18n/react";

interface PluginRegistryPreviewProps {
  catalog: PluginRegistryCatalog | undefined;
  query: string;
}

export function PluginRegistryPreview({ catalog, query }: PluginRegistryPreviewProps) {
  const { t } = useI18n();
  const entries = filterRegistryEntries(catalog?.packages ?? [], query);
  if (!catalog) {
    return <div className="plugin-registry-loading">{t("registry.loading")}</div>;
  }
  return (
    <>
      <div className="plugin-registry-notice">
        <FlaskConical size={15} />
        <span className="plugin-registry-notice-copy">
          <strong className="plugin-registry-notice-title">
            {catalog.developmentFixture ? t("registry.fixtureTitle") : t("registry.catalogTitle")}
          </strong>
          <small>
            {catalog.developmentFixture ? t("registry.fixtureNotice") : t("registry.catalogNotice")}
          </small>
        </span>
      </div>
      <div className="plugin-list plugin-registry-list">
        {entries.map((entry) => (
          <article className={entry.compatible ? undefined : "disabled"} key={entry.id}>
            <Puzzle size={18} />
            <div className="plugin-info">
              <span className="plugin-registry-heading">
                <strong className="plugin-name">{entry.name}</strong>
                <span
                  className={`plugin-registry-badge ${entry.compatible ? "compatible" : "incompatible"}`}
                >
                  {entry.compatible
                    ? t("registry.compatible")
                    : t("registry.requiresApi", { version: entry.apiVersion })}
                </span>
              </span>
              <span className="plugin-identity">
                {entry.id} · {entry.author}
              </span>
              <small className="plugin-registry-summary">{entry.summary}</small>
              <small className="plugin-metadata">
                {entry.compatibleVersion
                  ? t("registry.compatibleVersion", {
                      version: entry.compatibleVersion,
                      api: entry.apiVersion,
                    })
                  : t("registry.latestVersion", { version: entry.latestVersion })}{" "}
                {entry.compatibleVersion && entry.compatibleVersion !== entry.latestVersion
                  ? t("registry.latestSuffix", { version: entry.latestVersion })
                  : ""}
                ·{" "}
                {entry.capabilities.map(formatCapability).join(" · ") || t("plugin.noCapabilities")}
              </small>
            </div>
            <span className="plugin-manual-install" title={t("registry.installDisabled")}>
              <LockKeyhole size={12} /> {t("registry.manualFolder")}
            </span>
          </article>
        ))}
        {entries.length === 0 && (
          <div className="plugin-empty">
            <Puzzle size={22} />
            <strong>{t("registry.empty")}</strong>
            <span className="plugin-empty-copy">{t("registry.emptyHint")}</span>
          </div>
        )}
      </div>
      <small className="plugin-registry-source">
        {t("registry.source", {
          source: catalog.source,
          api: catalog.hostApiVersion,
          count: entries.length,
        })}
      </small>
    </>
  );
}

function formatCapability(capability: string): string {
  return capability.replace(/_/g, " ");
}

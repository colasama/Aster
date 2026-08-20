import { FlaskConical, LockKeyhole, Puzzle } from "lucide-react";
import { filterRegistryEntries, type PluginRegistryCatalog } from "../core/plugin-catalog";

interface PluginRegistryPreviewProps {
  catalog: PluginRegistryCatalog | undefined;
  query: string;
}

export function PluginRegistryPreview({ catalog, query }: PluginRegistryPreviewProps) {
  const entries = filterRegistryEntries(catalog?.packages ?? [], query);
  if (!catalog) {
    return <div className="plugin-registry-loading">Loading local registry preview…</div>;
  }
  return (
    <>
      <div className="plugin-registry-notice">
        <FlaskConical size={15} />
        <span className="plugin-registry-notice-copy">
          <strong className="plugin-registry-notice-title">
            {catalog.developmentFixture
              ? "Development fixture · catalog preview only"
              : "Registry catalog · manual install only"}
          </strong>
          <small>
            {catalog.developmentFixture
              ? "No network request, download, or plugin execution occurs. MVP installs only trusted local folders selected manually."
              : "This view does not install or execute plugins. Review package trust before selecting a local folder manually."}
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
                  {entry.compatible ? "Host compatible" : `Requires API ${entry.apiVersion}`}
                </span>
              </span>
              <span className="plugin-identity">
                {entry.id} · {entry.author}
              </span>
              <small className="plugin-registry-summary">{entry.summary}</small>
              <small className="plugin-metadata">
                {entry.compatibleVersion
                  ? `v${entry.compatibleVersion} for API ${entry.apiVersion}`
                  : `Latest v${entry.latestVersion}`}{" "}
                {entry.compatibleVersion && entry.compatibleVersion !== entry.latestVersion
                  ? `· latest v${entry.latestVersion} `
                  : ""}
                ·{" "}
                {entry.capabilities.map(formatCapability).join(" · ") ||
                  "No privileged capabilities"}
              </small>
            </div>
            <span className="plugin-manual-install" title="Automatic registry install is disabled">
              <LockKeyhole size={12} /> Manual folder
            </span>
          </article>
        ))}
        {entries.length === 0 && (
          <div className="plugin-empty">
            <Puzzle size={22} />
            <strong>No registry entries match this search</strong>
            <span className="plugin-empty-copy">
              Try a name, ID, version, compatibility state, author, or capability.
            </span>
          </div>
        )}
      </div>
      <small className="plugin-registry-source">
        {catalog.source} · host API {catalog.hostApiVersion} · {entries.length} shown
      </small>
    </>
  );
}

function formatCapability(capability: string): string {
  return capability.replace(/_/g, " ");
}

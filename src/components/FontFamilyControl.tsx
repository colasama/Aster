import { Upload } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";
import { createProjectFont } from "../core/font-import";
import { applyOperations, type Operation } from "../core/operations";
import { prepareProjectFonts } from "../core/project-font-runtime";
import type { Layer, TextStyle } from "../core/types";
import { listSystemFonts } from "../desktop/fonts";
import { useI18n } from "../i18n/react";
import { useEditor } from "../state/editor-store";
import { FontFamilyPicker } from "./FontFamilyPicker";

let inventory: { expires: number; families: Promise<string[]> } | undefined;

function systemFamilies() {
  if (!inventory || inventory.expires < Date.now()) {
    const families = listSystemFonts().then((fonts) => [
      ...new Set(fonts.map((font) => font.family)),
    ]);
    inventory = { expires: Date.now() + 60_000, families };
    void families.catch(() => {
      inventory = undefined;
    });
  }
  return inventory.families;
}

export function FontFamilyControl({
  layer,
  style,
  onChange,
}: {
  layer: Layer;
  style: TextStyle;
  onChange: (family: string) => void;
}) {
  const { state, dispatch } = useEditor();
  const { t } = useI18n();
  const latest = useRef(state);
  latest.current = state;
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [system, setSystem] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [importing, setImporting] = useState(false);
  const families = useMemo(
    () =>
      [...new Set([...system, ...(state.project.fonts ?? []).map((font) => font.family)])].sort(),
    [system, state.project.fonts],
  );
  const load = async () => {
    if (loading) return;
    setLoading(true);
    setError(undefined);
    try {
      setSystem(await systemFamilies());
    } catch {
      setError(t("text.fontListUnavailable"));
    } finally {
      setLoading(false);
    }
  };
  const importFile = async (file: File) => {
    const captured = latest.current;
    setImporting(true);
    setError(undefined);
    try {
      const family = file.name.replace(/\.[^.]+$/, "").slice(0, 120);
      const font = await createProjectFont(file, family);
      const operations: Operation[] = [
        { type: "addProjectFont", font },
        {
          type: "setTextStyle",
          layerId: layer.id,
          textStyle: { ...style, fontFamily: JSON.stringify(family), fontWeight: font.weight },
        },
      ];
      await prepareProjectFonts(applyOperations(captured.project, operations));
      if (
        latest.current.project.id !== captured.project.id ||
        latest.current.projectRevision !== captured.projectRevision
      )
        throw new Error(t("text.fontImportStale"));
      dispatch({ type: "operation", operations });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setImporting(false);
    }
  };
  return (
    <div className="font-family-control">
      <label htmlFor={id}>{t("text.fontFamily")}</label>
      <div className="font-family-field">
        <FontFamilyPicker
          key={layer.id}
          inputId={id}
          label={t("text.fontFamily")}
          emptyLabel={t("text.noFonts")}
          loading={loading}
          families={families}
          onOpen={() => void load()}
          onChange={onChange}
          value={style.fontFamily}
        />
        <button
          type="button"
          title={t(importing ? "text.fontImporting" : "text.importFont")}
          aria-label={t(importing ? "text.fontImporting" : "text.importFont")}
          disabled={importing}
          aria-busy={importing}
          onClick={() => fileInput.current?.click()}
        >
          <Upload size={14} aria-hidden="true" />
        </button>
      </div>
      <input
        ref={fileInput}
        type="file"
        hidden
        accept=".ttf,.otf,.woff,.woff2"
        aria-label={t("text.importFont")}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void importFile(file);
        }}
      />
      {error && <span role="alert">{error}</span>}
    </div>
  );
}

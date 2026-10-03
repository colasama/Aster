import { X } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { applyOperations } from "../../core/editing/operations";
import { fontFamilyNames } from "../../core/layers/text-style";
import { resolveFontAvailability } from "../../core/media/font-availability";
import {
  findMissingFontFamilies,
  fontReplacementOperations,
  type MissingFontFamily,
} from "../../core/project/missing-fonts";
import { listSystemFontFamilies } from "../../desktop/fonts";
import { useI18n } from "../../i18n/react";
import { useEditor } from "../../state/editor-store";
import { FontFamilyPicker } from "../inspector/FontFamilyPicker";
import { useDialogFocus } from "../use-dialog-focus";

/**
 * Checks each loaded document for text families that would render with the native fallback face
 * and offers replacements. Dismissing keeps the document unchanged, so the fallback face remains.
 */
export function MissingFontsPrompt() {
  const { state, dispatch } = useEditor();
  const latest = useRef(state);
  latest.current = state;
  const loadRevision = state.loadRevision;
  const [missing, setMissing] = useState<{
    readonly loadRevision: number;
    readonly families: readonly MissingFontFamily[];
  }>();
  useEffect(() => {
    if (loadRevision === 0) return;
    let active = true;
    const project = latest.current.project;
    void resolveFontAvailability(project)
      .then((isAvailable) => {
        const families = findMissingFontFamilies(project, isAvailable);
        if (active && families.length > 0) setMissing({ loadRevision, families });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [loadRevision]);
  if (!missing || missing.loadRevision !== loadRevision) return null;
  return (
    <MissingFontsDialog
      families={missing.families}
      onClose={() => setMissing(undefined)}
      onReplace={(replacements) => {
        const project = latest.current.project;
        const operations = fontReplacementOperations(project, replacements);
        if (operations.length > 0) {
          applyOperations(project, operations);
          dispatch({
            type: "operation",
            operations,
            metadata: { source: "user", summary: "Replace missing fonts" },
          });
        }
        setMissing(undefined);
      }}
    />
  );
}

export function MissingFontsDialog({
  families,
  onClose,
  onReplace,
}: {
  readonly families: readonly MissingFontFamily[];
  readonly onClose: () => void;
  readonly onReplace: (replacements: ReadonlyMap<string, string>) => void;
}) {
  const { t } = useI18n();
  const { state } = useEditor();
  const keepRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useDialogFocus<HTMLFormElement>({ initialFocusRef: keepRef, onClose });
  const [choices, setChoices] = useState<Readonly<Record<string, string>>>({});
  const [system, setSystem] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const available = useMemo(
    () =>
      [...new Set([...system, ...(state.project.fonts ?? []).map((font) => font.family)])].sort(),
    [system, state.project.fonts],
  );
  const chosen = families.filter((entry) => choices[entry.family]?.trim());
  const load = async () => {
    if (loading || system.length > 0) return;
    setLoading(true);
    try {
      setSystem(await listSystemFontFamilies());
    } catch {
      setError(t("text.fontListUnavailable"));
    } finally {
      setLoading(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (chosen.length === 0) return;
    try {
      onReplace(new Map(chosen.map((entry) => [entry.family, choices[entry.family]])));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const title = t("fonts.missing.title");
  return createPortal(
    <div className="modal-backdrop" role="presentation">
      <form
        aria-label={title}
        aria-modal="true"
        className="workspace-action-dialog missing-fonts-dialog"
        onSubmit={submit}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header>{title}</header>
        <ul>
          {families.map((entry) => {
            const name = fontFamilyNames(entry.family).join(", ");
            const choice = choices[entry.family] ?? "";
            return (
              <li key={entry.family}>
                <span className="missing-font-name" title={entry.family}>
                  {name}
                </span>
                <span className="missing-font-count">
                  {t("fonts.missing.layerCount", { count: entry.layerCount })}
                </span>
                <div className="font-family-field">
                  <FontFamilyPicker
                    label={t("fonts.missing.replacementFor", { family: name })}
                    emptyLabel={t("text.noFonts")}
                    placeholder={t("fonts.missing.fallback")}
                    loading={loading}
                    families={available}
                    onOpen={() => void load()}
                    onChange={(family) =>
                      setChoices((current) => ({ ...current, [entry.family]: family }))
                    }
                    value={choice}
                  />
                  {choice && (
                    <button
                      type="button"
                      title={t("fonts.missing.useFallback")}
                      aria-label={t("fonts.missing.useFallback")}
                      onClick={() =>
                        setChoices(({ [entry.family]: _removed, ...current }) => current)
                      }
                    >
                      <X size={14} aria-hidden="true" />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {error && <p role="alert">{error}</p>}
        <footer>
          <button onClick={onClose} ref={keepRef} type="button">
            {t("fonts.missing.keepFallback")}
          </button>
          <button className="primary" disabled={chosen.length === 0} type="submit">
            {t("fonts.missing.replace")}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}

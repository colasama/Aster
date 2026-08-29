import { type FormEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../i18n/react";

export type WorkspaceActionDialogMode = "saveAs" | "rename" | "delete";

export function WorkspaceActionDialog({
  currentName,
  mode,
  onClose,
  onSubmit,
}: {
  readonly currentName: string;
  readonly mode: WorkspaceActionDialogMode;
  readonly onClose: () => void;
  readonly onSubmit: (name: string) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(mode === "rename" ? currentName : currentName);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.select();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (mode !== "delete" && !name.trim()) return;
    onSubmit(name);
  };
  const title = t(`workspace.action.${mode}`);
  return createPortal(
    <div className="modal-backdrop" role="presentation">
      <form
        aria-label={title}
        aria-modal="true"
        className="workspace-action-dialog"
        onSubmit={submit}
        role="dialog"
      >
        <header>{title}</header>
        {mode === "delete" ? (
          <p>{t("workspace.confirm.delete", { name: currentName })}</p>
        ) : (
          <input
            aria-label={t("workspace.name")}
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
            ref={inputRef}
            value={name}
          />
        )}
        <footer>
          <button onClick={onClose} type="button">
            {t("common.cancel")}
          </button>
          <button className={mode === "delete" ? "destructive" : "primary"} type="submit">
            {title}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}

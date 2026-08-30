import { type FormEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../i18n/react";
import { useDialogFocus } from "../use-dialog-focus";

export type WorkspaceActionDialogMode = "saveAs" | "rename" | "delete";

export function WorkspaceActionDialog({
  currentName,
  deleteOptions = [],
  mode,
  onClose,
  onSubmit,
}: {
  readonly currentName: string;
  readonly deleteOptions?: readonly { readonly id: string; readonly name: string }[];
  readonly mode: WorkspaceActionDialogMode;
  readonly onClose: () => void;
  readonly onSubmit: (name: string) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(mode === "delete" ? (deleteOptions[0]?.id ?? "") : currentName);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const dialogRef = useDialogFocus<HTMLFormElement>({
    initialFocusRef: mode === "delete" ? selectRef : inputRef,
    onClose,
  });
  useEffect(() => {
    if (mode !== "delete") inputRef.current?.select();
  }, [mode]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    onSubmit(name);
  };
  const title = t(`workspace.action.${mode}`);
  const deleteName = deleteOptions.find((workspace) => workspace.id === name)?.name ?? currentName;
  return createPortal(
    <div className="modal-backdrop" role="presentation">
      <form
        aria-label={title}
        aria-modal="true"
        className="workspace-action-dialog"
        onSubmit={submit}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header>{title}</header>
        {mode === "delete" ? (
          <>
            <select
              aria-label={t("workspace.name")}
              onChange={(event) => setName(event.target.value)}
              ref={selectRef}
              value={name}
            >
              {deleteOptions.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
            <p>{t("workspace.confirm.delete", { name: deleteName })}</p>
          </>
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

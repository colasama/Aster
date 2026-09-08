import { Command, Search, X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useI18n } from "../../i18n/react";
import { useDialogFocus } from "../use-dialog-focus";

export function CommandPalette({
  commands,
  onClose,
}: {
  commands: readonly { label: string; action: () => void }[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useDialogFocus<HTMLDivElement>({ initialFocusRef: input, onClose });
  const listId = useId();
  const filtered = commands.filter((command) =>
    command.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const active = Math.min(selected, filtered.length - 1);
  const execute = (index: number) => {
    const command = filtered[index];
    if (!command) return;
    onClose();
    command.action();
  };
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        aria-label={t("topbar.command.placeholder")}
        aria-modal="true"
        className="command-palette"
        ref={dialog}
        role="dialog"
        tabIndex={-1}
      >
        <button
          aria-label={t("topbar.command.close")}
          className="palette-close"
          onClick={onClose}
          type="button"
        >
          <X size={13} />
        </button>
        <div className="palette-search">
          <Search size={15} />
          <input
            aria-label={t("topbar.command.placeholder")}
            aria-autocomplete="list"
            aria-controls={listId}
            aria-expanded="true"
            aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
            autoComplete="off"
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter") {
                event.preventDefault();
                execute(active);
              } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                if (filtered.length)
                  setSelected(
                    (active + (event.key === "ArrowDown" ? 1 : -1) + filtered.length) %
                      filtered.length,
                  );
              }
            }}
            placeholder={t("topbar.command.placeholder")}
            ref={input}
            role="combobox"
            value={query}
          />
        </div>
        <div
          aria-label={t("topbar.command.quick")}
          className="palette-results"
          id={listId}
          role="listbox"
        >
          {filtered.map((command, index) => (
            <button
              aria-selected={index === active}
              className={index === active ? "active" : ""}
              id={`${listId}-${index}`}
              key={command.label}
              onClick={() => execute(index)}
              onPointerMove={() => setSelected(index)}
              role="option"
              tabIndex={-1}
              type="button"
            >
              <Command size={12} />
              <span>{command.label}</span>
            </button>
          ))}
        </div>
        {filtered.length === 0 && (
          <div className="palette-empty" role="status">
            {t("topbar.command.empty")}
          </div>
        )}
      </div>
    </div>
  );
}

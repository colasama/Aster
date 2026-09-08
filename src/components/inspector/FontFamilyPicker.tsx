import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./font-family-picker.css";

const ROW_HEIGHT = 28;
const MAX_HEIGHT = 224;
const OVERSCAN = 3;

export function FontFamilyPicker({
  inputId,
  value,
  families,
  label,
  emptyLabel,
  loading,
  onOpen,
  onChange,
}: {
  inputId?: string;
  value: string;
  families: string[];
  label: string;
  emptyLabel: string;
  loading: boolean;
  onOpen: () => void;
  onChange: (family: string) => void;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [query, setQuery] = useState("");
  const [edited, setEdited] = useState(false);
  const [active, setActive] = useState(-1);
  const [scrollTop, setScrollTop] = useState(0);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 200, height: MAX_HEIGHT });
  const searchable = useMemo(
    () => families.map((family) => ({ family, search: family.toLowerCase() })),
    [families],
  );
  const filtered = useMemo(() => {
    const search = query
      .trim()
      .replace(/^['"]|['"]$/g, "")
      .toLowerCase();
    return searchable.filter((entry) => entry.search.includes(search));
  }, [query, searchable]);
  const height = Math.min(position.height, Math.max(1, filtered.length) * ROW_HEIGHT);
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(filtered.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
  const activeId = active >= start && active < end ? `${id}-${active}` : undefined;

  useLayoutEffect(() => {
    if (!open) return;
    const reposition = () => {
      const rect = input.current?.getBoundingClientRect();
      if (!rect) return;
      const below = window.innerHeight - rect.bottom - 8;
      const above = rect.top - 8;
      const upward = below < MAX_HEIGHT && above > below;
      const available = Math.max(ROW_HEIGHT, Math.min(MAX_HEIGHT, upward ? above : below));
      const popupHeight = Math.min(available, Math.max(1, filtered.length) * ROW_HEIGHT);
      const width = Math.min(Math.max(rect.width, 200), window.innerWidth - 16);
      setPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        top: upward ? rect.top - popupHeight - 4 : rect.bottom + 4,
        width,
        height: available,
      });
    };
    reposition();
    window.addEventListener("resize", reposition);
    const onScroll = (event: Event) => {
      if (event.target !== list.current) reposition();
    };
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, filtered.length]);

  const show = () => {
    if (open) return;
    setDraft(value);
    setQuery("");
    setEdited(false);
    setActive(-1);
    setScrollTop(0);
    setOpen(true);
    onOpen();
  };
  const commit = (family: string) => {
    if (family.trim() && family !== value) onChange(family);
    setEdited(false);
    setOpen(false);
  };
  const move = (index: number) => {
    if (!filtered.length) return;
    const next = Math.max(0, Math.min(filtered.length - 1, index));
    setActive(next);
    const top = next * ROW_HEIGHT;
    const current = list.current?.scrollTop ?? 0;
    const offset =
      top < current
        ? top
        : top + ROW_HEIGHT > current + height
          ? top + ROW_HEIGHT - height
          : current;
    if (list.current) list.current.scrollTop = offset;
    setScrollTop(offset);
  };
  return (
    <>
      <input
        id={inputId}
        ref={input}
        type="text"
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-activedescendant={open ? activeId : undefined}
        aria-busy={loading}
        autoComplete="off"
        maxLength={160}
        value={open ? draft : value}
        onFocus={show}
        onClick={show}
        onBlur={() => {
          if (edited) commit(draft);
          else setOpen(false);
        }}
        onChange={(event) => {
          setOpen(true);
          setDraft(event.target.value);
          setQuery(event.target.value);
          setEdited(true);
          setActive(-1);
          setScrollTop(0);
          if (list.current) list.current.scrollTop = 0;
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            event.stopPropagation();
            setEdited(false);
            setOpen(false);
          } else if (event.key === "Enter" && open) {
            event.preventDefault();
            event.stopPropagation();
            commit(
              active >= 0 && filtered[active] ? JSON.stringify(filtered[active].family) : draft,
            );
          } else if (
            ["ArrowDown", "ArrowUp", "PageDown", "PageUp"].includes(event.key) ||
            (open && ["Home", "End"].includes(event.key) && active >= 0)
          ) {
            event.preventDefault();
            event.stopPropagation();
            if (!open) {
              show();
              return;
            }
            const page = Math.max(1, Math.floor(height / ROW_HEIGHT));
            move(
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? filtered.length - 1
                  : active +
                    (event.key === "ArrowDown"
                      ? 1
                      : event.key === "ArrowUp"
                        ? -1
                        : event.key === "PageDown"
                          ? page
                          : -page),
            );
          }
        }}
      />
      {open &&
        createPortal(
          <div
            ref={list}
            id={id}
            role="listbox"
            aria-label={label}
            aria-busy={loading}
            className="font-family-list"
            style={{ left: position.left, top: position.top, width: position.width, height }}
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          >
            <div
              style={{ height: Math.max(1, filtered.length) * ROW_HEIGHT, position: "relative" }}
            >
              {filtered.slice(start, end).map(({ family }, offset) => {
                const index = start + offset;
                return (
                  <button
                    type="button"
                    tabIndex={-1}
                    key={family}
                    id={`${id}-${index}`}
                    role="option"
                    aria-selected={active === index}
                    aria-posinset={index + 1}
                    aria-setsize={filtered.length}
                    className="font-family-option"
                    style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => commit(JSON.stringify(family))}
                    title={family}
                  >
                    {family}
                  </button>
                );
              })}
              {!filtered.length && (
                <div className="font-family-empty" role="status">
                  {loading ? "…" : emptyLabel}
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

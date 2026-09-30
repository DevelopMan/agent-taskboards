import { useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { LabelCount, LabelMatchMode } from "../../domain/types";
import { suggestTags } from "../../lib/task-labels";
import { Icon, LabelChip } from "./index";

// A type-ahead tag field: typing suggests tags in use, Enter or a click adds
// the highlighted one as a removable chip inside the field, and Backspace in
// an empty field removes the last chip.
export function TagFilter({
  labels,
  match,
  onChange,
  placeholder = "Filter by tag…",
  selected,
}: {
  labels: LabelCount[];
  match: LabelMatchMode;
  onChange: (selected: string[], match: LabelMatchMode) => void;
  placeholder?: string;
  selected: string[];
}) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listboxId = useId();
  const suggestions = useMemo(() => suggestTags(labels, selected, text), [labels, selected, text]);
  const activeIndex = Math.min(highlight, suggestions.length - 1);
  const menuVisible = open && (suggestions.length > 0 || text.trim().length > 0);

  const addTag = (label: string) => {
    onChange([...selected, label], match);
    setText("");
    setHighlight(0);
  };
  const removeTag = (label: string) => {
    onChange(selected.filter((item) => item !== label), match);
    inputRef.current?.focus();
  };
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      if (suggestions.length > 0) {
        const step = event.key === "ArrowDown" ? 1 : -1;
        setHighlight((activeIndex + step + suggestions.length) % suggestions.length);
      }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const suggestion = open ? suggestions[activeIndex] : undefined;
      if (suggestion) {
        addTag(suggestion.label);
      } else {
        setOpen(true);
      }
      return;
    }
    if (event.key === "Escape" && menuVisible) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (event.key === "Backspace" && !text) {
      const last = selected[selected.length - 1];
      if (last !== undefined) {
        event.preventDefault();
        onChange(selected.slice(0, -1), match);
      }
    }
  };

  return (
    <div className="tag-filter">
      <div className="tag-input" onClick={() => inputRef.current?.focus()}>
        <span className="tag-input__tokens">
          {selected.map((label) => (
            <span className="editable-label-chip" key={label}>
              <LabelChip label={label} />
              <button
                aria-label={`Remove tag filter ${label}`}
                className="label-chip__remove"
                onClick={(event) => {
                  event.stopPropagation();
                  removeTag(label);
                }}
                title="Remove tag filter"
                type="button"
              >
                <Icon name="close" size={11} />
              </button>
            </span>
          ))}
          <input
            aria-activedescendant={menuVisible && activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined}
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-expanded={menuVisible}
            aria-label="Filter by tag"
            className="tag-input__field"
            onBlur={() => setOpen(false)}
            onChange={(event) => {
              setText(event.target.value);
              setHighlight(0);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={handleKeyDown}
            placeholder={selected.length > 0 ? "" : placeholder}
            ref={inputRef}
            role="combobox"
            spellCheck={false}
            type="text"
            value={text}
          />
        </span>
        {menuVisible && (
          <ul className="tag-input__menu" id={listboxId} role="listbox">
            {suggestions.length === 0 ? (
              <li className="tag-input__empty">No matching tags</li>
            ) : (
              suggestions.map((item, index) => (
                <li
                  aria-selected={index === activeIndex}
                  className={index === activeIndex ? "tag-input__option tag-input__option--active" : "tag-input__option"}
                  id={`${listboxId}-${index}`}
                  key={item.label}
                  // Keep focus in the field so the next tag can be typed right away.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    event.stopPropagation();
                    addTag(item.label);
                  }}
                  onMouseEnter={() => setHighlight(index)}
                  role="option"
                >
                  <LabelChip label={item.label} />
                  <span className="tag-input__count">{item.count}</span>
                </li>
              ))
            )}
          </ul>
        )}
      </div>
      {selected.length > 1 && (
        <div aria-label="Tag match mode" className="segmented" role="group">
          {(["all", "any"] as const).map((mode) => (
            <button
              aria-pressed={match === mode}
              className={match === mode ? "segmented__item segmented__item--active" : "segmented__item"}
              key={mode}
              onClick={() => onChange(selected, mode)}
              title={mode === "all" ? "Match cards with every selected tag" : "Match cards with any selected tag"}
              type="button"
            >
              {mode === "all" ? "All" : "Any"}
            </button>
          ))}
        </div>
      )}
      {selected.length > 0 && (
        <button className="tag-filter__clear" onClick={() => onChange([], match)} type="button">
          Clear
        </button>
      )}
    </div>
  );
}

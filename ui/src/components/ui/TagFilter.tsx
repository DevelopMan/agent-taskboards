import type { LabelCount, LabelMatchMode } from "../../domain/types";
import { Icon, LabelChip } from "./index";

export function TagFilter({
  labels,
  match,
  onChange,
  selected,
}: {
  labels: LabelCount[];
  match: LabelMatchMode;
  onChange: (selected: string[], match: LabelMatchMode) => void;
  selected: string[];
}) {
  const selectedSet = new Set(selected);
  const available = labels.filter((item) => !selectedSet.has(item.label));

  return (
    <div className="tag-filter">
      <select
        aria-label="Add tag filter"
        className="tag-filter__select"
        disabled={available.length === 0}
        onChange={(event) => {
          const label = event.target.value;
          if (label) {
            onChange([...selected, label], match);
          }
        }}
        value=""
      >
        <option value="">
          {available.length === 0 ? "No tags" : selected.length > 0 ? "Add tag…" : "Filter by tag…"}
        </option>
        {available.map((item) => (
          <option key={item.label} value={item.label}>
            {item.label} ({item.count})
          </option>
        ))}
      </select>
      {selected.length > 0 && (
        <span className="tag-filter__chips">
          {selected.map((label) => (
            <span className="editable-label-chip" key={label}>
              <LabelChip label={label} />
              <button
                aria-label={`Remove tag filter ${label}`}
                className="label-chip__remove"
                onClick={() => onChange(selected.filter((item) => item !== label), match)}
                title="Remove tag filter"
                type="button"
              >
                <Icon name="close" size={11} />
              </button>
            </span>
          ))}
        </span>
      )}
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

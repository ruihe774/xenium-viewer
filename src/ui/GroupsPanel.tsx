import { useRef, useState } from "react";
import { useApp } from "../store";
import { categoryColor } from "./colormaps";

function css(color: [number, number, number]) {
  return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

/**
 * Import and display of cell-group assignment files
 * (`cell_id, group[, color]`) — the equivalent of Xenium Explorer's cell
 * groups. Colours declared in the file win; anything without one falls back to
 * the categorical palette.
 */
export function GroupsPanel() {
  const dataset = useApp((s) => s.dataset);
  const cells = useApp((s) => s.cells);
  const groupSets = useApp((s) => s.groupSets);
  const importing = useApp((s) => s.groupImporting);
  const importError = useApp((s) => s.groupImportError);
  const importGroupFiles = useApp((s) => s.importGroupFiles);
  const removeGroupSet = useApp((s) => s.removeGroupSet);
  const coloring = useApp((s) => s.cellColoring);
  const setCellColoring = useApp((s) => s.setCellColoring);
  const toggleGroupCategory = useApp((s) => s.toggleGroupCategory);
  const setGroupCategoriesHidden = useApp((s) => s.setGroupCategoriesHidden);

  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  if (!dataset?.table) return null;
  const ready = cells.status === "ready";
  const active = groupSets.find(
    (g) => coloring.mode === "group" && g.name === coloring.column,
  );

  return (
    <section className="section">
      <h2>Cell groups</h2>
      <div
        className={`content dropzone${dragging ? " over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const files = [...e.dataTransfer.files].filter((f) => /\.(csv|tsv|txt)$/i.test(f.name));
          if (files.length) void importGroupFiles(files);
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.tsv,.txt"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            if (files.length) void importGroupFiles(files);
            e.target.value = "";
          }}
        />
        <button onClick={() => inputRef.current?.click()} disabled={!ready || importing}>
          {importing ? "Importing…" : "Import CSV…"}
        </button>
        <p className="dim hint">
          {groupSets.length === 0
            ? "Drop files here, or pick them. Columns: cell_id, group, and an optional color."
            : "Drop more files to add another set."}
        </p>

        {importError && <div className="error">{importError}</div>}

        {groupSets.map((set) => {
          const selected = coloring.mode === "group" && coloring.column === set.name;
          return (
            <div className={`groupset${selected ? " selected" : ""}`} key={set.name}>
              <div className="groupset-head">
                <input
                  type="radio"
                  name="groupset"
                  checked={selected}
                  onChange={() => void setCellColoring({ mode: "group", column: set.name })}
                  aria-label={`Colour cells by ${set.name}`}
                />
                <span className="groupset-name" title={set.name}>
                  {set.name}
                </span>
                <button
                  className="link"
                  onClick={() => void removeGroupSet(set.name)}
                  aria-label={`Remove ${set.name}`}
                >
                  remove
                </button>
              </div>
              <p className="dim hint">
                {set.categories.length} groups · {set.matched.toLocaleString("en-US")} cells
                {set.unmatched > 0 && ` · ${set.unmatched.toLocaleString("en-US")} unmatched`}
              </p>
            </div>
          );
        })}

        {active && (
          <>
            <div className="legend-head">
              <span className="dim">Groups</span>
              <span>
                <button className="link" onClick={() => setGroupCategoriesHidden(active.name, [])}>
                  all
                </button>
                <button
                  className="link"
                  onClick={() =>
                    setGroupCategoriesHidden(active.name, [...active.categories])
                  }
                >
                  none
                </button>
              </span>
            </div>
            <ul className="legend">
              {active.categories.map((label, i) => {
                const hidden = active.hidden.includes(label);
                return (
                  <li key={label}>
                    <button
                      className={`legend-row${hidden ? " off" : ""}`}
                      onClick={() => toggleGroupCategory(active.name, label)}
                      title={`${label} — ${active.counts[i].toLocaleString("en-US")} cells`}
                    >
                      <span
                        className="legend-dot"
                        style={{ background: css(active.colors[i] ?? categoryColor(i)) }}
                      />
                      <span className="legend-label">{label}</span>
                      <span className="legend-count">
                        {active.counts[i].toLocaleString("en-US")}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}

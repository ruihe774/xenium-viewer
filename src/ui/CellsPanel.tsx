import { useApp } from "../store";
import { RangeSlider } from "./RangeSlider";
import { COLORMAP_NAMES, categoryColor, colormapCss } from "./colormaps";

/** ~200 steps across the column's range, snapped to a power of ten. */
function rangeStep(min: number, max: number): number {
  const raw = (max - min) / 200;
  if (!(raw > 0)) return 1;
  return Math.max(10 ** Math.round(Math.log10(raw)), 1e-4);
}

export function CellsPanel() {
  const dataset = useApp((s) => s.dataset);
  const cells = useApp((s) => s.cells);
  const showCells = useApp((s) => s.showCells);
  const setShowCells = useApp((s) => s.setShowCells);
  const cellOpacity = useApp((s) => s.cellOpacity);
  const setCellOpacity = useApp((s) => s.setCellOpacity);
  const showCellBoundaries = useApp((s) => s.showCellBoundaries);
  const setShowCellBoundaries = useApp((s) => s.setShowCellBoundaries);
  const showNucleusBoundaries = useApp((s) => s.showNucleusBoundaries);
  const setShowNucleusBoundaries = useApp((s) => s.setShowNucleusBoundaries);
  const boundaryStyle = useApp((s) => s.boundaryStyle);
  const setBoundaryStyle = useApp((s) => s.setBoundaryStyle);
  const boundaryStatus = useApp((s) => s.boundaryStatus);
  const groupSets = useApp((s) => s.groupSets);
  const coloring = useApp((s) => s.cellColoring);
  const setCellColoring = useApp((s) => s.setCellColoring);

  if (!dataset?.table) return null;
  const columns = dataset.table.columns;
  const column = cells.columnData;

  return (
    <section className="section">
      <h2>Cells</h2>
      <div className="content">
        <label className="check-row">
          <input
            type="checkbox"
            checked={showCells}
            onChange={(e) => setShowCells(e.target.checked)}
          />
          <span>
            Show cells
            {cells.status === "ready" && (
              <span className="dim"> ({cells.n.toLocaleString("en-US")})</span>
            )}
          </span>
        </label>

        {cells.status === "loading" && <p className="dim">Loading centroids…</p>}
        {cells.status === "error" && <div className="error">{cells.error}</div>}

        <label className="check-row sub">
          <input
            type="checkbox"
            checked={showCellBoundaries}
            disabled={!showCells}
            onChange={(e) => setShowCellBoundaries(e.target.checked)}
          />
          <span>Cell boundaries</span>
        </label>
        <label className="check-row sub">
          <input
            type="checkbox"
            checked={showNucleusBoundaries}
            disabled={!showCells}
            onChange={(e) => setShowNucleusBoundaries(e.target.checked)}
          />
          <span>Nucleus boundaries</span>
        </label>
        {/* Always mounted, one line, so toggling between these states — which
            happens rapidly while panning/zooming — doesn't shift the layout
            below. */}
        <p className={`status-line ${boundaryStatus.error ? "error" : "dim"}`}>
          {boundaryStatus.error ??
            (boundaryStatus.loading
              ? "Loading boundaries…"
              : boundaryStatus.tooMany
                ? boundaryStatus.dotsVisible
                  ? "Too many cells in view for outlines — showing centroids."
                  : "Zoom in to see cell boundaries."
                : "Boundaries loaded.")}
        </p>
        <label className="field">
          <span>Style</span>
          <select
            value={boundaryStyle}
            disabled={!showCells || !showCellBoundaries}
            onChange={(e) => setBoundaryStyle(e.target.value as "outline" | "fill" | "both")}
          >
            <option value="outline">Outline</option>
            <option value="fill">Fill</option>
            <option value="both">Outline + fill</option>
          </select>
        </label>

        <label className="field">
          <span>Colour by</span>
          <select
            // Values are namespaced because an imported file can share a name
            // with an obs column.
            value={coloring.mode === "uniform" ? "" : `${coloring.mode}:${coloring.column}`}
            onChange={(e) => {
              const [mode, ...rest] = e.target.value.split(":");
              void setCellColoring(
                e.target.value
                  ? {
                      mode: mode as "column" | "group",
                      column: rest.join(":"),
                      range: undefined,
                    }
                  : { mode: "uniform", column: undefined },
              );
            }}
          >
            <option value="">Uniform</option>
            {groupSets.length > 0 && (
              <optgroup label="Cell groups">
                {groupSets.map((g) => (
                  <option key={g.name} value={`group:${g.name}`}>
                    {g.name}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="Table columns">
              {columns.map((c) => (
                <option key={c.name} value={`column:${c.name}`}>
                  {c.name}
                </option>
              ))}
            </optgroup>
          </select>
        </label>

        {column?.kind === "numeric" && (
          <>
            <label className="field">
              <span>Colormap</span>
              <select
                value={coloring.colormap}
                onChange={(e) => void setCellColoring({ colormap: e.target.value })}
              >
                {COLORMAP_NAMES.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <div className="ramp" style={{ background: colormapCss(coloring.colormap) }} />
            <RangeSlider
              min={column.min}
              max={column.max}
              step={rangeStep(column.min, column.max)}
              value={coloring.range ?? [column.p1, column.p99]}
              onChange={(range) => void setCellColoring({ range })}
            />
            <button
              className="link"
              onClick={() => void setCellColoring({ range: [column.p1, column.p99] })}
            >
              reset to 1–99%
            </button>
          </>
        )}

        {/* Group sets get a richer legend of their own, with counts and
            per-group visibility, so it is not repeated here. */}
        {column?.kind === "categorical" && coloring.mode !== "group" && (
          <ul className="legend">
            {column.categories.slice(0, 24).map((label, i) => (
              <li key={label}>
                <span
                  className="legend-dot"
                  style={{ background: `rgb(${categoryColor(i).join(",")})` }}
                />
                <span title={label}>{label}</span>
              </li>
            ))}
            {column.categories.length > 24 && (
              <li className="dim">+{column.categories.length - 24} more</li>
            )}
          </ul>
        )}

        <label className="slider-row">
          <span>Opacity</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={cellOpacity}
            onChange={(e) => setCellOpacity(Number(e.target.value))}
          />
          <span className="num">{Math.round(cellOpacity * 100)}%</span>
        </label>
      </div>
    </section>
  );
}

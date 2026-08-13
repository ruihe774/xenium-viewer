import { useRef, useState } from "react";
import { useApp } from "../store";
import { ColorSwatch } from "./ColorSwatch";

/**
 * Import and display of a single alternative segmentation from a GeoJSON
 * FeatureCollection of cell polygons — e.g. a Cellpose or Baysor re-run,
 * drawn as an overlay to judge against the Xenium boundaries. Mirrors
 * `GroupsPanel`'s import flow, but there is only ever one imported set:
 * importing again replaces it.
 */
export function SegmentationPanel() {
  const dataset = useApp((s) => s.dataset);
  const segmentation = useApp((s) => s.segmentation);
  const importing = useApp((s) => s.segmentationImporting);
  const progress = useApp((s) => s.segmentationProgress);
  const importError = useApp((s) => s.segmentationError);
  const importSegmentation = useApp((s) => s.importSegmentation);
  const removeSegmentation = useApp((s) => s.removeSegmentation);
  const show = useApp((s) => s.showSegmentation);
  const setShow = useApp((s) => s.setShowSegmentation);
  const color = useApp((s) => s.segmentationColor);
  const setColor = useApp((s) => s.setSegmentationColor);
  const style = useApp((s) => s.segmentationStyle);
  const setStyle = useApp((s) => s.setSegmentationStyle);
  const opacity = useApp((s) => s.segmentationOpacity);
  const setOpacity = useApp((s) => s.setSegmentationOpacity);
  const status = useApp((s) => s.segmentationStatus);

  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  if (!dataset?.table) return null;

  const pickFile = (files: FileList | File[]) => {
    const file = [...files].find((f) => /\.(geo)?json$/i.test(f.name));
    if (file) void importSegmentation(file);
  };

  return (
    <section className="section">
      <h2>Segmentation</h2>
      <div
        className={`content dropzone segmentation${dragging ? " over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          pickFile(e.dataTransfer.files);
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".geojson,.json"
          hidden
          onChange={(e) => {
            pickFile(e.target.files ?? []);
            e.target.value = "";
          }}
        />
        <button onClick={() => inputRef.current?.click()} disabled={importing}>
          {importing ? `Importing… ${Math.round(progress * 100)}%` : "Import GeoJSON…"}
        </button>
        {!segmentation && (
          <p className="dim hint">
            Drop a GeoJSON FeatureCollection of cell polygons here, or pick a file, to compare an
            alternative segmentation against the Xenium boundaries.
          </p>
        )}

        {importing && (
          <div className="progress">
            <div className="progress-fill" style={{ width: `${progress * 100}%` }} />
          </div>
        )}
        {importError && <div className="error">{importError}</div>}

        {segmentation && (
          <div className="groupset selected">
            <div className="groupset-head">
              <input
                type="checkbox"
                checked={show}
                onChange={(e) => setShow(e.target.checked)}
                aria-label="Show alternative segmentation"
              />
              <ColorSwatch
                color={color}
                onChange={setColor}
                label="Colour for alternative segmentation"
              />
              <span className="groupset-name" title={segmentation.name}>
                {segmentation.name}
              </span>
              <button
                className="link"
                onClick={() => void removeSegmentation()}
                aria-label="Remove alternative segmentation"
              >
                remove
              </button>
            </div>
            <p className="dim hint">
              {segmentation.count.toLocaleString("en-US")} polygons ·{" "}
              {segmentation.vertices.toLocaleString("en-US")} vertices
              {segmentation.skipped > 0 &&
                ` · ${segmentation.skipped.toLocaleString("en-US")} skipped`}
              {segmentation.droppedRings > 0 &&
                ` · ${segmentation.droppedRings.toLocaleString("en-US")} rings dropped`}
            </p>
            {segmentation.outOfBounds && (
              <div className="error">
                This geometry mostly falls outside the slide — check that the coordinates in the
                file are in micrometres, not pixels.
              </div>
            )}

            {/* Always mounted, like the Cells panel's boundary status line, so
                toggling between these states while panning doesn't shift the
                layout below. */}
            <p className={`status-line ${status.error ? "error" : "dim"}`}>
              {status.error ??
                (status.loading
                  ? "Loading segmentation…"
                  : status.tooMany
                    ? "Zoom in to see the alternative segmentation."
                    : "Segmentation loaded.")}
            </p>

            <label className="field">
              <span>Style</span>
              <select
                value={style}
                disabled={!show}
                onChange={(e) => setStyle(e.target.value as "outline" | "fill" | "both")}
              >
                <option value="outline">Outline</option>
                <option value="fill">Fill</option>
                <option value="both">Outline + fill</option>
              </select>
            </label>

            <label className="slider-row">
              <span>Opacity</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={opacity}
                disabled={!show}
                onChange={(e) => setOpacity(Number(e.target.value))}
              />
              <span className="num">{Math.round(opacity * 100)}%</span>
            </label>
          </div>
        )}
      </div>
    </section>
  );
}

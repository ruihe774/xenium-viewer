import { useApp } from "../store";
import { GeneList } from "./GeneList";
import { categoryColor } from "./colormaps";

function compact(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return n.toLocaleString("en-US");
}

export function TranscriptsPanel() {
  const dataset = useApp((s) => s.dataset);
  const genes = useApp((s) => s.genes);
  const info = useApp((s) => s.transcriptInfo);
  const status = useApp((s) => s.transcriptStatus);
  const show = useApp((s) => s.showTranscripts);
  const setShow = useApp((s) => s.setShowTranscripts);
  const pointSize = useApp((s) => s.transcriptPointSize);
  const setPointSize = useApp((s) => s.setTranscriptPointSize);
  const opacity = useApp((s) => s.transcriptOpacity);
  const setOpacity = useApp((s) => s.setTranscriptOpacity);
  const picked = useApp((s) => s.transcriptGenes);
  const toggleGene = useApp((s) => s.toggleTranscriptGene);
  const hideOthers = useApp((s) => s.hideOtherTranscripts);
  const setHideOthers = useApp((s) => s.setHideOtherTranscripts);

  const element = dataset?.points[0];
  if (!element) return null;

  const colorOf = (gene: string) => {
    const i = picked.indexOf(gene);
    return i < 0 ? undefined : `rgb(${categoryColor(i).join(",")})`;
  };

  return (
    <section className="section">
      <h2>Transcripts</h2>
      <div className="content">
        <label className="check-row">
          <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
          <span>
            Show transcripts
            {info && <span className="dim"> ({compact(info.totalRows)})</span>}
          </span>
        </label>

        {/* One line, always mounted: this flips between states on every pan. */}
        <p className={`status-line ${status.error ? "error" : "dim"}`}>
          {status.error ??
            (!show
              ? "Hidden."
              : status.loading
                ? "Reading transcripts…"
                : status.tooMany
                  ? `${compact(status.total)} in view — zoom in.`
                  : status.total > status.count
                    ? `Showing ${compact(status.count)} of ${compact(status.total)}.`
                    : `${compact(status.count)} in view.`)}
        </p>

        <label className="slider-row">
          <span>Size</span>
          <input
            type="range"
            min={0.5}
            max={4}
            step={0.5}
            value={pointSize}
            disabled={!show}
            onChange={(e) => setPointSize(Number(e.target.value))}
          />
          <span className="num">{pointSize}px</span>
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

        {genes.length > 0 && (
          <>
            <p className="dim">
              Highlight genes
              {picked.length > 0 && <span> ({picked.length} picked)</span>}
            </p>
            <label className="check-row sub">
              <input
                type="checkbox"
                checked={hideOthers}
                disabled={!show || picked.length === 0}
                onChange={(e) => setHideOthers(e.target.checked)}
              />
              <span>Hide the rest</span>
            </label>
            <GeneList
              genes={genes}
              selected={picked}
              onPick={toggleGene}
              colorOf={colorOf}
              placeholder="Search genes to highlight…"
            />
          </>
        )}
      </div>
    </section>
  );
}

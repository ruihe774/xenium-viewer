import { useApp } from "../store";
import { clearSettings } from "../data/settings";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

export function DatasetSummary() {
  const dataset = useApp((s) => s.dataset);
  if (!dataset) return null;

  const primary = dataset.images.find((i) => i.name === "morphology_focus") ?? dataset.images[0];
  const nf = new Intl.NumberFormat("en-US");
  const mm = (px: number) => ((px * dataset.pixelSizeUm) / 1000).toFixed(1);

  return (
    <section className="section">
      <h2>Dataset</h2>
      <div className="content">
        <dl className="kv">
          <Row label="Reader" value={dataset.reader ?? "unknown"} />
          <Row label="Image" value={primary.name} />
          <Row
            label="Size"
            value={`${nf.format(primary.width)} × ${nf.format(primary.height)} px`}
          />
          <Row label="Physical" value={`${mm(primary.width)} × ${mm(primary.height)} mm`} />
          <Row label="Pixel size" value={`${dataset.pixelSizeUm.toFixed(4)} µm`} />
          <Row label="Levels" value={primary.levels.map((l) => `${l.width}`).join(" / ")} />
          <Row label="Channels" value={primary.channels.map((c) => c.label).join(", ")} />
          <Row label="Cells" value={dataset.table ? nf.format(dataset.table.nObs) : "—"} />
          <Row label="Genes" value={dataset.table?.nVar ? nf.format(dataset.table.nVar) : "—"} />
          <Row label="Shapes" value={dataset.shapes.map((s) => s.name).join(", ") || "—"} />
          <Row label="Labels" value={dataset.labels.map((s) => s.name).join(", ") || "—"} />
        </dl>
        <button
          className="reset-view"
          onClick={() => {
            clearSettings(dataset.name);
            window.location.reload();
          }}
        >
          Reset view options
        </button>
      </div>
    </section>
  );
}

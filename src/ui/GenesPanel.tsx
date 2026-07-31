import { useApp } from "../store";
import { GeneList } from "./GeneList";

export function GenesPanel() {
  const dataset = useApp((s) => s.dataset);
  const genes = useApp((s) => s.genes);
  const matrixStatus = useApp((s) => s.matrixStatus);
  const coloring = useApp((s) => s.cellColoring);
  const setCellColoring = useApp((s) => s.setCellColoring);

  if (!dataset?.table?.x || genes.length === 0) return null;
  const selected = coloring.mode === "gene" && coloring.column ? [coloring.column] : [];

  return (
    <section className="section">
      <h2>
        Genes
        {selected.length > 0 && (
          <button
            className="link"
            onClick={() => void setCellColoring({ mode: "uniform", column: undefined })}
          >
            clear
          </button>
        )}
      </h2>
      <div className="content">
        <p className="dim">
          {genes.length.toLocaleString("en-US")} genes. Pick one to colour cells by its count.
        </p>

        {/* Always mounted so the panel does not jump as the matrix loads. */}
        <p className={`status-line ${matrixStatus.status === "error" ? "error" : "dim"}`}>
          {matrixStatus.status === "error"
            ? matrixStatus.error
            : matrixStatus.status === "loading"
              ? `Reading expression matrix… ${Math.round(matrixStatus.progress * 100)}%`
              : matrixStatus.status === "ready"
                ? "Expression matrix loaded."
                : "The matrix is read once, when you pick a gene."}
        </p>
        {matrixStatus.status === "loading" && (
          <div className="progress">
            <div className="progress-fill" style={{ width: `${matrixStatus.progress * 100}%` }} />
          </div>
        )}

        <GeneList
          genes={genes}
          selected={selected}
          onPick={(gene) =>
            void setCellColoring(
              coloring.mode === "gene" && coloring.column === gene
                ? { mode: "uniform", column: undefined }
                : { mode: "gene", column: gene, range: undefined },
            )
          }
        />
      </div>
    </section>
  );
}

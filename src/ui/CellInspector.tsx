import { Fragment } from "react";
import { useApp } from "../store";

export function CellInspector() {
  const selectedCell = useApp((s) => s.selectedCell);
  const details = useApp((s) => s.cellDetails);
  const topGenes = useApp((s) => s.selectedCellGenes);
  const selectCell = useApp((s) => s.selectCell);
  const setCellColoring = useApp((s) => s.setCellColoring);

  if (selectedCell === undefined) return null;

  return (
    <section className="section">
      <h2>
        Selected cell
        <button className="link" onClick={() => void selectCell(undefined)}>
          clear
        </button>
      </h2>
      <div className="content">
        {!details && <p className="dim">Loading…</p>}
        {details && (
          <dl className="kv">
            {Object.entries(details).map(([key, value]) => (
              <Fragment key={key}>
                <dt title={key}>{key}</dt>
                <dd title={value}>{value}</dd>
              </Fragment>
            ))}
          </dl>
        )}
        {/* A CSR row is contiguous, so this arrives without the whole matrix
            having been read — usually before the obs columns do. */}
        {topGenes && topGenes.length > 0 && (
          <>
            <p className="dim">Top genes</p>
            <dl className="kv">
              {topGenes.map(({ gene, count }) => (
                <Fragment key={gene}>
                  <dt>
                    <button
                      className="link"
                      onClick={() =>
                        void setCellColoring({ mode: "gene", column: gene, range: undefined })
                      }
                    >
                      {gene}
                    </button>
                  </dt>
                  <dd>{count.toLocaleString("en-US")}</dd>
                </Fragment>
              ))}
            </dl>
          </>
        )}
      </div>
    </section>
  );
}

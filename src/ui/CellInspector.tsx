import { Fragment } from "react";
import { useApp } from "../store";

export function CellInspector() {
  const selectedCell = useApp((s) => s.selectedCell);
  const details = useApp((s) => s.cellDetails);
  const selectCell = useApp((s) => s.selectCell);

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
      </div>
    </section>
  );
}

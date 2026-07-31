import { useState } from "react";

/**
 * Rows rendered at once. A 5,101-gene panel is far past what a `<select>` or a
 * plain list can show, and past what a person can scan — the search box is the
 * real navigation, so the list only has to show enough to confirm a match.
 */
const MAX_ROWS = 200;

interface GeneListProps {
  genes: string[];
  /** Genes to mark as picked. */
  selected: readonly string[];
  onPick: (gene: string) => void;
  /** CSS colour for a gene's dot, when the caller assigns colours. */
  colorOf?: (gene: string) => string | undefined;
  placeholder?: string;
}

/** Prefix matches first — typing "CD4" should not bury CD4 under NCD47. */
function search(genes: string[], query: string): { rows: string[]; total: number } {
  const q = query.trim().toLowerCase();
  if (!q) return { rows: genes.slice(0, MAX_ROWS), total: genes.length };
  const prefix: string[] = [];
  const contains: string[] = [];
  for (const gene of genes) {
    const lower = gene.toLowerCase();
    if (lower.startsWith(q)) prefix.push(gene);
    else if (lower.includes(q)) contains.push(gene);
  }
  const all = prefix.concat(contains);
  return { rows: all.slice(0, MAX_ROWS), total: all.length };
}

export function GeneList({ genes, selected, onPick, colorOf, placeholder }: GeneListProps) {
  const [query, setQuery] = useState("");
  const { rows, total } = search(genes, query);

  return (
    <>
      <input
        className="gene-search"
        type="search"
        placeholder={placeholder ?? "Search genes…"}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {total === 0 && <p className="dim">No genes match “{query.trim()}”.</p>}
      <ul className="gene-list">
        {rows.map((gene) => (
          <li key={gene}>
            <button
              className={`gene-row${selected.includes(gene) ? " selected" : ""}`}
              onClick={() => onPick(gene)}
            >
              {colorOf && (
                <span
                  className="legend-dot"
                  style={{ background: colorOf(gene) ?? "transparent" }}
                />
              )}
              <span title={gene}>{gene}</span>
            </button>
          </li>
        ))}
      </ul>
      {total > rows.length && (
        <p className="dim">
          Showing {rows.length} of {total.toLocaleString("en-US")} matches.
        </p>
      )}
    </>
  );
}

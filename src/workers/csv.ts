/**
 * Small RFC 4180-ish reader.
 *
 * Group labels are free text and can legitimately contain commas, so quoted
 * fields have to be handled rather than splitting on `,`. Rows are yielded one
 * at a time to keep a 12 MB file from being materialised twice.
 */
export function forEachRow(text: string, visit: (row: string[]) => void): void {
  const row: string[] = [];
  let field = "";
  let quoted = false;
  let sawContent = false;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    // Ignore trailing blank lines, but keep genuinely empty fields.
    if (sawContent) visit(row.slice());
    row.length = 0;
    sawContent = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      sawContent = true;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      sawContent = true;
    } else if (ch === ",") {
      endField();
      sawContent = true;
    } else if (ch === "\n") {
      endRow();
    } else if (ch !== "\r") {
      field += ch;
      sawContent = true;
    }
  }
  if (sawContent) endRow();
}

export interface ColumnLayout {
  id: number;
  group: number;
  color: number;
}

/**
 * Locates the id / group / colour columns.
 *
 * Returns `undefined` for `headerConsumed` when the first row holds data rather
 * than names, in which case the columns are taken positionally.
 */
export function resolveLayout(first: string[]): { layout: ColumnLayout; hasHeader: boolean } {
  const normalized = first.map((h) => h.trim().toLowerCase());
  const find = (...names: string[]) => normalized.findIndex((h) => names.includes(h));

  const id = find("cell_id", "cellid", "cell", "id", "barcode");
  const group = find("group", "cluster", "annotation", "label", "cell_type", "celltype");
  if (id >= 0 && group >= 0) {
    return {
      layout: { id, group, color: find("color", "colour", "hex") },
      hasHeader: true,
    };
  }
  return { layout: { id: 0, group: 1, color: 2 }, hasHeader: false };
}

/** Parses `#rgb`, `#rrggbb`, or `r,g,b`. Returns undefined for anything else. */
export function parseColor(value: string): [number, number, number] | undefined {
  const text = value.trim();
  if (text === "") return undefined;
  if (text.startsWith("#")) {
    const hex = text.slice(1);
    if (hex.length === 3) {
      const [r, g, b] = [...hex].map((c) => Number.parseInt(c + c, 16));
      return Number.isNaN(r + g + b) ? undefined : [r, g, b];
    }
    if (hex.length === 6) {
      const n = Number.parseInt(hex, 16);
      return Number.isNaN(n) ? undefined : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    return undefined;
  }
  const parts = text.split(/[\s,]+/).map(Number);
  if (parts.length === 3 && parts.every((p) => Number.isFinite(p) && p >= 0 && p <= 255)) {
    return [parts[0], parts[1], parts[2]];
  }
  return undefined;
}

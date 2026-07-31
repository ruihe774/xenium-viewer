/// <reference lib="webworker" />
import * as Comlink from "comlink";
import * as zarr from "zarrita";
import { parquetRead } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import type { ObsColumn, TableElement, XYTransform } from "../data/dataset";
import { type DataSource, type SourceSpec, createDataSource } from "../data/stores";
import { type ColumnLayout, forEachRow, parseColor, resolveLayout } from "./csv";
import { UniformGrid } from "./grid";
import { wkbReadRing, wkbVertexCount } from "./wkb";

export interface CellsInit {
  n: number;
  /** Interleaved x,y centroids in level-0 image pixels. Transferred. */
  positions: Float32Array;
}

export type ColumnData =
  | {
      kind: "numeric";
      values: Float32Array;
      min: number;
      max: number;
      /** 1st and 99th percentiles — the default colour range. */
      p1: number;
      p99: number;
    }
  | {
      kind: "categorical";
      /** Category index per cell; -1 where the cell has no value. */
      codes: Int32Array;
      categories: string[];
      /** Cells per category, aligned with `categories`. */
      counts: Uint32Array;
      /** Explicit colour per category, where the source supplied one. */
      colors?: ([number, number, number] | null)[];
    };

export interface GroupSetSummary {
  name: string;
  categories: string[];
  counts: number[];
  colors: ([number, number, number] | null)[];
  /** Rows whose cell id matched a row in the table. */
  matched: number;
  /** Rows whose cell id was not found in the table. */
  unmatched: number;
  elapsedMs: number;
}

const PERCENTILE_BINS = 2048;

/**
 * Percentile bounds from a histogram.
 *
 * Xenium obs columns (transcript counts especially) have long tails, so a
 * min/max colour range leaves almost every cell at the bottom of the ramp.
 */
function percentiles(values: Float32Array, min: number, max: number) {
  if (!(max > min)) return { p1: min, p99: max };
  const bins = new Uint32Array(PERCENTILE_BINS);
  const scale = PERCENTILE_BINS / (max - min);
  for (let i = 0; i < values.length; i++) {
    const bin = (values[i] - min) * scale;
    bins[bin >= PERCENTILE_BINS ? PERCENTILE_BINS - 1 : bin < 0 ? 0 : bin | 0]++;
  }
  const at = (p: number) => {
    let seen = 0;
    const target = values.length * p;
    for (let b = 0; b < PERCENTILE_BINS; b++) {
      seen += bins[b];
      if (seen >= target) return min + (b / PERCENTILE_BINS) * (max - min);
    }
    return max;
  };
  return { p1: at(0.01), p99: at(0.99) };
}

export interface BoundarySummary {
  count: number;
  vertices: number;
  elapsedMs: number;
}

export type ViewportShapes =
  | { tooMany: true; count: number }
  | {
      tooMany: false;
      count: number;
      /** Flat x,y vertex pairs for all returned polygons. */
      positions: Float32Array;
      /** Vertex index where each polygon starts, plus a final terminator. */
      startIndices: Uint32Array;
      /** Row index in the table for each polygon; -1 when unmatched. */
      cellIndices: Int32Array;
    };

/**
 * Declared with property rather than method syntax throughout: methods are
 * bivariant in their parameters and trip `unbound-method` when a caller pulls
 * one off the object, which is exactly how these are consumed.
 */
export interface CellsWorkerApi {
  init: (spec: SourceSpec, table: TableElement, toPixel: XYTransform) => Promise<CellsInit>;
  column: (name: string) => Promise<ColumnData>;
  importGroups: (name: string, text: string) => Promise<GroupSetSummary>;
  removeGroups: (name: string) => void;
  details: (index: number) => Promise<Record<string, string>>;
  loadBoundaries: (
    name: string,
    parquetPath: string,
    toPixel: XYTransform,
  ) => Promise<BoundarySummary>;
  viewportShapes: (
    name: string,
    box: [number, number, number, number],
    maxCells: number,
  ) => ViewportShapes;
}

interface Boundaries {
  count: number;
  coords: Float32Array;
  starts: Uint32Array;
  bboxes: Float32Array;
  cellIndices: Int32Array;
  grid: UniformGrid;
}

/** Grid bucket size in level-0 pixels (~435 µm) — a few hundred cells each. */
const GRID_CELL_PX = 2048;

function toNumberArray(data: unknown, length: number): Float32Array {
  const out = new Float32Array(length);
  if (data instanceof BigInt64Array || data instanceof BigUint64Array) {
    for (let i = 0; i < length; i++) out[i] = Number(data[i]);
  } else if (ArrayBuffer.isView(data)) {
    out.set(data as unknown as ArrayLike<number>);
  } else if (Array.isArray(data)) {
    for (let i = 0; i < length; i++) out[i] = Number(data[i]);
  }
  return out;
}

/** Reads AnnData's string-ish encodings into a plain array of strings. */
function toStringArray(data: unknown, length: number): string[] {
  if (Array.isArray(data)) return data as string[];
  const out = new Array<string>(length);
  const indexable = data as { get(i: number): unknown };
  for (let i = 0; i < length; i++) out[i] = String(indexable.get(i));
  return out;
}

class CellStore implements CellsWorkerApi {
  #source!: DataSource;
  #store!: zarr.AsyncReadable;
  #table!: TableElement;
  #columns = new Map<string, Promise<ColumnData>>();
  #strings = new Map<string, Promise<string[]>>();
  #boundaries = new Map<string, Boundaries>();
  #pendingBoundaries = new Map<string, Promise<BoundarySummary>>();
  /** Imported cell-group assignments, keyed by the name shown in the UI. */
  #groups = new Map<string, ColumnData>();
  #n = 0;

  async init(spec: SourceSpec, table: TableElement, toPixel: XYTransform) {
    this.#source = createDataSource(spec);
    this.#store = this.#source.store;
    this.#table = table;
    if (!table.spatialPath) throw new Error("Table has no obsm/spatial centroids");

    const arr = await this.#open(table.spatialPath);
    const { data, shape } = await zarr.get(arr);
    const n = shape[0];
    this.#n = n;

    // obsm/spatial is in micrometres; the viewer works in level-0 pixels.
    const source = data as unknown as ArrayLike<number>;
    const positions = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      positions[i * 2] = source[i * 2] * toPixel.sx + toPixel.tx;
      positions[i * 2 + 1] = source[i * 2 + 1] * toPixel.sy + toPixel.ty;
    }
    return Comlink.transfer({ n, positions }, [positions.buffer]);
  }

  #open(path: string) {
    return zarr.open(zarr.root(this.#store).resolve(path), { kind: "array" });
  }

  #spec(name: string): ObsColumn {
    const column =
      name === this.#table.indexColumn.name
        ? this.#table.indexColumn
        : this.#table.columns.find((c) => c.name === name);
    if (!column) throw new Error(`No obs column named "${name}"`);
    return column;
  }

  column(name: string): Promise<ColumnData> {
    const imported = this.#groups.get(name);
    if (imported) return Promise.resolve(imported);
    let pending = this.#columns.get(name);
    if (!pending) {
      pending = this.#readColumn(this.#spec(name));
      this.#columns.set(name, pending);
    }
    return pending;
  }

  async #readColumn(spec: ObsColumn): Promise<ColumnData> {
    if (spec.kind === "categorical") {
      // AnnData categorical: a `categories` string array plus integer `codes`.
      // Booleans are stored as a plain array instead, with no children.
      const [categories, codes] = await Promise.all([
        this.#maybeStrings(`${spec.path}/categories`),
        this.#maybeCodes(spec.path),
      ]);
      return { kind: "categorical", codes, categories, counts: tally(codes, categories.length) };
    }
    if (spec.kind === "string") {
      const values = await this.#stringColumn(spec.path);
      const lookup = new Map<string, number>();
      const categories: string[] = [];
      const codes = new Int32Array(values.length);
      for (let i = 0; i < values.length; i++) {
        let code = lookup.get(values[i]);
        if (code === undefined) {
          code = categories.push(values[i]) - 1;
          lookup.set(values[i], code);
        }
        codes[i] = code;
      }
      return { kind: "categorical", codes, categories, counts: tally(codes, categories.length) };
    }

    const arr = await this.#open(spec.path);
    const { data } = await zarr.get(arr);
    const values = toNumberArray(data, this.#n);
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < values.length; i++) {
      if (values[i] < min) min = values[i];
      if (values[i] > max) max = values[i];
    }
    return { kind: "numeric", values, min, max, ...percentiles(values, min, max) };
  }

  async #maybeCodes(path: string): Promise<Int32Array> {
    const arr = await this.#open(`${path}/codes`).catch(() => this.#open(path));
    const { data } = await zarr.get(arr);
    const out = new Int32Array(this.#n);
    if (data instanceof Int8Array || data instanceof Int16Array || data instanceof Int32Array) {
      out.set(data);
    } else {
      const indexable = data as { get?(i: number): unknown } & ArrayLike<unknown>;
      for (let i = 0; i < this.#n; i++) {
        const v = indexable.get ? indexable.get(i) : indexable[i];
        out[i] = v === true ? 1 : v === false ? 0 : Number(v);
      }
    }
    return out;
  }

  async #maybeStrings(path: string): Promise<string[]> {
    try {
      return await this.#stringColumn(path);
    } catch {
      // A boolean column has no `categories` child.
      return ["false", "true"];
    }
  }

  /**
   * Reads a string column, transparently handling AnnData's
   * `nullable-string-array` layout (a `values` child plus a `mask`).
   */
  #stringColumn(path: string): Promise<string[]> {
    let pending = this.#strings.get(path);
    if (!pending) {
      pending = (async () => {
        const arr = await this.#open(`${path}/values`).catch(() => this.#open(path));
        const { data, shape } = await zarr.get(arr);
        return toStringArray(data, shape[0]);
      })();
      this.#strings.set(path, pending);
    }
    return pending;
  }

  /**
   * Loads a cell-group assignment file: `cell_id, group[, color]`.
   *
   * The colour column is optional both per file and per row — the sample files
   * declare each group's colour on a single row and leave it blank elsewhere —
   * so the first non-empty value seen for a group wins, and groups without one
   * fall back to the categorical palette at render time.
   */
  async importGroups(name: string, text: string): Promise<GroupSetSummary> {
    const started = performance.now();
    const tableIds = await this.#stringColumn(this.#table.indexColumn.path);
    const rowOf = new Map<string, number>();
    for (let i = 0; i < tableIds.length; i++) rowOf.set(tableIds[i], i);

    const codes = new Int32Array(this.#n).fill(-1);
    const categories: string[] = [];
    const colors: ([number, number, number] | null)[] = [];
    const codeOf = new Map<string, number>();
    const counts: number[] = [];
    let matched = 0;
    let unmatched = 0;
    let layout: ColumnLayout | undefined;

    forEachRow(text, (row) => {
      if (!layout) {
        const resolved = resolveLayout(row);
        layout = resolved.layout;
        if (resolved.hasHeader) return;
      }
      const id = row[layout.id]?.trim();
      const label = row[layout.group]?.trim();
      if (!id || label === undefined || label === "") return;

      let code = codeOf.get(label);
      if (code === undefined) {
        code = categories.push(label) - 1;
        codeOf.set(label, code);
        colors.push(null);
        counts.push(0);
      }
      if (colors[code] === null && layout.color >= 0) {
        colors[code] = parseColor(row[layout.color] ?? "") ?? null;
      }

      const cell = rowOf.get(id);
      if (cell === undefined) {
        unmatched++;
        return;
      }
      codes[cell] = code;
      counts[code]++;
      matched++;
    });

    if (categories.length === 0) {
      throw new Error("No group assignments found — expected columns cell_id, group[, color]");
    }
    if (matched === 0) {
      // Parsing "succeeded" but nothing lined up, which in practice means the
      // wrong columns were picked or the file belongs to another slide.
      throw new Error(
        `None of the ${unmatched.toLocaleString("en-US")} cell ids matched this dataset. ` +
          "Expected columns cell_id, group[, color].",
      );
    }

    this.#groups.set(name, {
      kind: "categorical",
      codes,
      categories,
      counts: Uint32Array.from(counts),
      colors,
    });

    return {
      name,
      categories,
      counts,
      colors,
      matched,
      unmatched,
      elapsedMs: Math.round(performance.now() - started),
    };
  }

  // Not async: Comlink surfaces every worker method as a promise to callers
  // regardless, so there is nothing to gain from marking it here.
  removeGroups(name: string) {
    this.#groups.delete(name);
  }

  loadBoundaries(name: string, parquetPath: string, toPixel: XYTransform) {
    let pending = this.#pendingBoundaries.get(name);
    if (!pending) {
      pending = this.#readBoundaries(name, parquetPath, toPixel);
      this.#pendingBoundaries.set(name, pending);
    }
    return pending;
  }

  /**
   * Decodes a GeoParquet shapes file into flat vertex arrays.
   *
   * `geoparquet: false` matters: hyparquet otherwise turns every row into a
   * GeoJSON object, which for 600k polygons costs far more than the raw decode.
   * The WKB blobs are read straight into typed arrays and then dropped.
   */
  async #readBoundaries(
    name: string,
    parquetPath: string,
    toPixel: XYTransform,
  ): Promise<BoundarySummary> {
    const started = performance.now();
    const file = await this.#source.openFile(parquetPath);
    if (!file) throw new Error(`Missing shapes file: ${parquetPath}`);

    let geometry: Uint8Array[] = [];
    let ids: string[] | undefined;
    await parquetRead({
      file,
      columns: ["geometry", "cell_id"],
      // `geoparquet: false` skips hyparquet's WKB -> GeoJSON conversion, which
      // for 600k polygons costs far more than the decode itself.
      geoparquet: false,
      // `utf8: false` stops plain BYTE_ARRAY columns being text-decoded, which
      // would mangle every WKB byte >= 0x80. Columns with a STRING logical type
      // (cell_id) still come back as strings.
      utf8: false,
      compressors,
      onChunk: (chunk) => {
        if (chunk.columnName === "geometry") {
          geometry = geometry.concat(Array.from(chunk.columnData) as Uint8Array[]);
        } else if (chunk.columnName === "cell_id") {
          ids = (ids ?? []).concat(Array.from(chunk.columnData) as string[]);
        }
      },
    });

    const count = geometry.length;
    const starts = new Uint32Array(count + 1);
    let total = 0;
    for (let i = 0; i < count; i++) {
      starts[i] = total;
      total += wkbVertexCount(geometry[i]);
    }
    starts[count] = total;

    const coords = new Float32Array(total * 2);
    const bboxes = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      wkbReadRing(geometry[i], coords, starts[i], toPixel.sx, toPixel.sy, toPixel.tx, toPixel.ty);
      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (let v = starts[i]; v < starts[i + 1]; v++) {
        const x = coords[v * 2];
        const y = coords[v * 2 + 1];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      bboxes[i * 4] = minX;
      bboxes[i * 4 + 1] = minY;
      bboxes[i * 4 + 2] = maxX;
      bboxes[i * 4 + 3] = maxY;
    }
    geometry = [];

    const tableIds = await this.#stringColumn(this.#table.indexColumn.path);
    const cellIndices = matchToTable(ids, tableIds, count);
    ids = undefined;

    this.#boundaries.set(name, {
      count,
      coords,
      starts,
      bboxes,
      cellIndices,
      grid: new UniformGrid(bboxes, count, GRID_CELL_PX),
    });
    return { count, vertices: total, elapsedMs: Math.round(performance.now() - started) };
  }

  viewportShapes(
    name: string,
    box: [number, number, number, number],
    maxCells: number,
  ): ViewportShapes {
    const boundaries = this.#boundaries.get(name);
    if (!boundaries) return { tooMany: false, count: 0, ...emptyShapes() };
    const [x0, y0, x1, y1] = box;

    const hits: number[] = [];
    let overflow = false;
    boundaries.grid.forEachInBox(x0, y0, x1, y1, (i) => {
      if (overflow) return;
      const b = i * 4;
      if (
        boundaries.bboxes[b] > x1 ||
        boundaries.bboxes[b + 2] < x0 ||
        boundaries.bboxes[b + 1] > y1 ||
        boundaries.bboxes[b + 3] < y0
      ) {
        return;
      }
      if (hits.length >= maxCells) {
        overflow = true;
        return;
      }
      hits.push(i);
    });
    if (overflow) return { tooMany: true, count: hits.length };

    let vertices = 0;
    for (const i of hits) vertices += boundaries.starts[i + 1] - boundaries.starts[i];

    const positions = new Float32Array(vertices * 2);
    const startIndices = new Uint32Array(hits.length + 1);
    const cellIndices = new Int32Array(hits.length);
    let write = 0;
    for (let k = 0; k < hits.length; k++) {
      const i = hits[k];
      const from = boundaries.starts[i];
      const to = boundaries.starts[i + 1];
      startIndices[k] = write;
      positions.set(boundaries.coords.subarray(from * 2, to * 2), write * 2);
      write += to - from;
      cellIndices[k] = boundaries.cellIndices[i];
    }
    startIndices[hits.length] = write;

    return Comlink.transfer(
      { tooMany: false as const, count: hits.length, positions, startIndices, cellIndices },
      [positions.buffer, startIndices.buffer, cellIndices.buffer],
    );
  }

  async details(index: number): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const ids = await this.#stringColumn(this.#table.indexColumn.path);
    out[this.#table.indexColumn.name] = ids[index] ?? String(index);
    // Imported group memberships first — they are what the user just chose to
    // look at, so they belong above the generic obs columns.
    for (const [name, groups] of this.#groups) {
      if (groups.kind !== "categorical") continue;
      out[name] = groups.categories[groups.codes[index]] ?? "—";
    }
    for (const spec of this.#table.columns) {
      const column = await this.column(spec.name);
      out[spec.name] =
        column.kind === "numeric"
          ? formatNumber(column.values[index])
          : (column.categories[column.codes[index]] ?? "—");
    }
    return out;
  }
}

function tally(codes: Int32Array, categoryCount: number): Uint32Array {
  const counts = new Uint32Array(categoryCount);
  for (let i = 0; i < codes.length; i++) {
    if (codes[i] >= 0 && codes[i] < categoryCount) counts[codes[i]]++;
  }
  return counts;
}

function emptyShapes() {
  return {
    positions: new Float32Array(0),
    startIndices: new Uint32Array(1),
    cellIndices: new Int32Array(0),
  };
}

/** Row index in the table for each polygon, matched on cell id. */
function matchToTable(
  ids: string[] | undefined,
  tableIds: string[],
  count: number,
): Int32Array {
  const out = new Int32Array(count);
  // cell_boundaries is written in table order, so skip the map entirely when
  // the ids line up. nucleus_boundaries does not (a cell can have >1 nucleus).
  if (!ids || (ids.length === count && ids[0] === tableIds[0] && ids[count - 1] === tableIds[count - 1])) {
    for (let i = 0; i < count; i++) out[i] = i < tableIds.length ? i : -1;
    return out;
  }
  const lookup = new Map<string, number>();
  for (let i = 0; i < tableIds.length; i++) lookup.set(tableIds[i], i);
  for (let i = 0; i < count; i++) out[i] = lookup.get(ids[i]) ?? -1;
  return out;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (Number.isInteger(value)) return value.toLocaleString("en-US");
  return value.toFixed(2);
}

Comlink.expose(new CellStore());

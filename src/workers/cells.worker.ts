/// <reference lib="webworker" />
import * as Comlink from "comlink";
import * as zarr from "zarrita";
import { parquetRead } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import type { ObsColumn, TableElement, XYTransform } from "../data/dataset";
import { type DataSource, type SourceSpec, createDataSource } from "../data/stores";
import { extent, percentiles, readStringArray, toNumberArray } from "./anndata";
import { type ColumnLayout, forEachRow, parseColor, resolveLayout } from "./csv";
import { IMPORTED_SEGMENTATION_KEY, exteriorRing, forEachFeature } from "./geojson";
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

export interface BoundarySummary {
  count: number;
  vertices: number;
  elapsedMs: number;
}

export interface GeoJsonSummary {
  count: number;
  vertices: number;
  /** Features with no usable Polygon/MultiPolygon ring, or fewer than 3 points. */
  skipped: number;
  /** Interior rings and extra MultiPolygon parts dropped, as `wkb.ts` does for WKB. */
  droppedRings: number;
  /** Extent of the imported geometry in level-0 pixels, for an out-of-bounds check. */
  bounds: [number, number, number, number];
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
  ids: () => Promise<string[]>;
  column: (name: string) => Promise<ColumnData>;
  importGroups: (name: string, text: string) => Promise<GroupSetSummary>;
  removeGroups: (name: string) => void;
  details: (index: number) => Promise<Record<string, string>>;
  loadBoundaries: (
    name: string,
    parquetPath: string,
    toPixel: XYTransform,
  ) => Promise<BoundarySummary>;
  importGeoJson: (
    file: File,
    toPixel: XYTransform,
    onProgress: (fraction: number) => void,
  ) => Promise<GeoJsonSummary>;
  removeGeoJson: () => void;
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

  ids(): Promise<string[]> {
    return this.#stringColumn(this.#table.indexColumn.path);
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
    const { min, max } = extent(values);
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

  /** Memoized string column read; the ids are re-read by several callers. */
  #stringColumn(path: string): Promise<string[]> {
    let pending = this.#strings.get(path);
    if (!pending) {
      pending = readStringArray(this.#store, path);
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

    // Categories arrive in first-seen order; the legend reads best sorted by
    // name, so remap codes to a sorted order before storing.
    const order = categories
      .map((_, i) => i)
      .sort((a, b) => categories[a].localeCompare(categories[b]));
    const rank = new Array<number>(order.length);
    order.forEach((oldCode, newCode) => (rank[oldCode] = newCode));
    for (let i = 0; i < codes.length; i++) {
      if (codes[i] >= 0) codes[i] = rank[codes[i]];
    }
    const sortedCategories = order.map((i) => categories[i]);
    const sortedColors = order.map((i) => colors[i]);
    const sortedCounts = order.map((i) => counts[i]);

    this.#groups.set(name, {
      kind: "categorical",
      codes,
      categories: sortedCategories,
      counts: Uint32Array.from(sortedCounts),
      colors: sortedColors,
    });

    return {
      name,
      categories: sortedCategories,
      counts: sortedCounts,
      colors: sortedColors,
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

  /**
   * Decodes a user-imported GeoJSON FeatureCollection into the same flat
   * layout `#readBoundaries` builds from GeoParquet/WKB, stored under the
   * fixed `IMPORTED_SEGMENTATION_KEY` — there is only ever one imported
   * segmentation, and re-importing replaces it.
   *
   * The total vertex count isn't known ahead of time (unlike the WKB path,
   * which has already materialised every geometry blob before its prefix-sum
   * pass), so `coords`/`starts`/`bboxes` grow by doubling as features stream
   * in, then are trimmed to their exact size once done.
   *
   * Feature ids are intentionally not read: an alternative segmentation's ids
   * are a different vocabulary from the cell table's (see CLAUDE.md), so
   * `cellIndices` is left at -1 throughout — `expandColors` already paints
   * unmatched polygons with the caller's fallback colour, which is exactly
   * the flat "this is a different segmentation" colour this needs.
   */
  async importGeoJson(
    file: File,
    toPixel: XYTransform,
    onProgress: (fraction: number) => void,
  ): Promise<GeoJsonSummary> {
    const started = performance.now();
    const totalBytes = file.size || 1;

    let count = 0;
    let vertexTotal = 0;
    let skipped = 0;
    let droppedRings = 0;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    let vertexCap = 1 << 20; // 1M vertices
    let coords = new Float32Array(vertexCap * 2);
    let polyCap = 1 << 16;
    let starts = new Uint32Array(polyCap + 1);
    let bboxes = new Float32Array(polyCap * 4);

    const ensureVertexCap = (needed: number) => {
      if (needed <= vertexCap) return;
      let cap = vertexCap;
      while (cap < needed) cap *= 2;
      const next = new Float32Array(cap * 2);
      next.set(coords.subarray(0, vertexTotal * 2));
      coords = next;
      vertexCap = cap;
    };
    const ensurePolyCap = (needed: number) => {
      if (needed <= polyCap) return;
      let cap = polyCap;
      while (cap < needed) cap *= 2;
      const nextStarts = new Uint32Array(cap + 1);
      nextStarts.set(starts.subarray(0, count + 1));
      starts = nextStarts;
      const nextBboxes = new Float32Array(cap * 4);
      nextBboxes.set(bboxes.subarray(0, count * 4));
      bboxes = nextBboxes;
      polyCap = cap;
    };

    await forEachFeature(
      file,
      (feature) => {
        const ring = exteriorRing(feature.geometry);
        if (!ring || ring.length < 3) {
          skipped++;
          return;
        }
        const geom = feature.geometry;
        if (geom?.type === "Polygon") {
          const rings = geom.coordinates as number[][][];
          droppedRings += Math.max(0, rings.length - 1);
        } else if (geom?.type === "MultiPolygon") {
          const parts = geom.coordinates as number[][][][];
          let totalRings = 0;
          for (const part of parts) totalRings += part.length;
          droppedRings += Math.max(0, totalRings - 1);
        }

        ensurePolyCap(count + 1);
        ensureVertexCap(vertexTotal + ring.length);

        const start = vertexTotal;
        let rMinX = Number.POSITIVE_INFINITY;
        let rMinY = Number.POSITIVE_INFINITY;
        let rMaxX = Number.NEGATIVE_INFINITY;
        let rMaxY = Number.NEGATIVE_INFINITY;
        for (let i = 0; i < ring.length; i++) {
          const x = ring[i][0] * toPixel.sx + toPixel.tx;
          const y = ring[i][1] * toPixel.sy + toPixel.ty;
          coords[(start + i) * 2] = x;
          coords[(start + i) * 2 + 1] = y;
          if (x < rMinX) rMinX = x;
          if (x > rMaxX) rMaxX = x;
          if (y < rMinY) rMinY = y;
          if (y > rMaxY) rMaxY = y;
        }
        vertexTotal += ring.length;
        starts[count] = start;
        bboxes[count * 4] = rMinX;
        bboxes[count * 4 + 1] = rMinY;
        bboxes[count * 4 + 2] = rMaxX;
        bboxes[count * 4 + 3] = rMaxY;
        if (rMinX < minX) minX = rMinX;
        if (rMinY < minY) minY = rMinY;
        if (rMaxX > maxX) maxX = rMaxX;
        if (rMaxY > maxY) maxY = rMaxY;
        count++;
      },
      (bytesRead) => onProgress(Math.min(1, bytesRead / totalBytes)),
    );
    starts[count] = vertexTotal;

    const finalCoords = coords.slice(0, vertexTotal * 2);
    const finalStarts = starts.slice(0, count + 1);
    const finalBboxes = bboxes.slice(0, count * 4);
    const cellIndices = new Int32Array(count).fill(-1);

    this.#boundaries.set(IMPORTED_SEGMENTATION_KEY, {
      count,
      coords: finalCoords,
      starts: finalStarts,
      bboxes: finalBboxes,
      cellIndices,
      grid: new UniformGrid(finalBboxes, count, GRID_CELL_PX),
    });

    return {
      count,
      vertices: vertexTotal,
      skipped,
      droppedRings,
      bounds: count > 0 ? [minX, minY, maxX, maxY] : [0, 0, 0, 0],
      elapsedMs: Math.round(performance.now() - started),
    };
  }

  removeGeoJson() {
    this.#boundaries.delete(IMPORTED_SEGMENTATION_KEY);
    this.#pendingBoundaries.delete(IMPORTED_SEGMENTATION_KEY);
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
function matchToTable(ids: string[] | undefined, tableIds: string[], count: number): Int32Array {
  const out = new Int32Array(count);
  // cell_boundaries is written in table order, so skip the map entirely when
  // the ids line up. nucleus_boundaries does not (a cell can have >1 nucleus).
  if (
    !ids ||
    (ids.length === count && ids[0] === tableIds[0] && ids[count - 1] === tableIds[count - 1])
  ) {
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

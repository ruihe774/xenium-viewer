/// <reference lib="webworker" />
import * as Comlink from "comlink";
import { parquetMetadataAsync, parquetRead } from "hyparquet";
import type { FileMetaData } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { UNKNOWN_FEATURE, type XYTransform } from "../data/dataset";
import {
  type AsyncBuffer,
  type DataSource,
  type SourceSpec,
  createDataSource,
} from "../data/stores";

export interface TranscriptsInit {
  parts: number;
  rowGroups: number;
  totalRows: number;
  /** Level-0 pixel bounds of every point. */
  bounds: [number, number, number, number];
  elapsedMs: number;
}

export type ViewportPoints =
  | { tooMany: true; estimate: number }
  | {
      tooMany: false;
      /** Points returned. */
      count: number;
      /** Points inside the box, before the cap. */
      total: number;
      /** Interleaved x,y in level-0 image pixels. Transferred. */
      positions: Float32Array;
      /** Gene index per point; UNKNOWN_FEATURE for anything not in `var`. */
      codes: Uint16Array;
    };

export interface TranscriptsWorkerApi {
  init: (
    spec: SourceSpec,
    parquetPath: string,
    toPixel: XYTransform,
    genes: string[],
  ) => Promise<TranscriptsInit>;
  viewport: (box: [number, number, number, number], maxPoints: number) => Promise<ViewportPoints>;
}

/**
 * Decoded row groups held in the worker, in bytes. Each 1.05M-row group costs
 * ~10.5 MB, so this keeps ~24 of them — enough that panning inside a region
 * re-reads nothing.
 */
const CACHE_BYTES = 256 * 1024 * 1024;

interface RowGroupEntry {
  part: number;
  rowStart: number;
  rowEnd: number;
  rows: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface DecodedGroup {
  x: Float32Array;
  y: Float32Array;
  codes: Uint16Array;
  bytes: number;
}

function statBound(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return undefined;
}

/** Orders `part.N.parquet` numerically; a plain sort puts part.10 before part.2. */
function partOrder(name: string): number {
  const match = /(\d+)/.exec(name);
  return match ? Number(match[1]) : 0;
}

/**
 * Reads the transcripts points element.
 *
 * The whole table is 402.7M rows across 69 parquet parts and 7.1 GB, so it is
 * never loaded. Instead every row group's x/y statistics are read from the
 * footers once, and a viewport query decodes only the row groups it overlaps —
 * a 1000x1000 µm view touches 8 of 417. Only x, y and feature_name are
 * projected: that is 5.2 compressed bytes per row against ~18 for the full
 * schema, most of the difference being transcript_id and the dask index.
 */
class TranscriptStore implements TranscriptsWorkerApi {
  #source!: DataSource;
  #files: AsyncBuffer[] = [];
  #entries: RowGroupEntry[] = [];
  #geneIndex = new Map<string, number>();
  #cache = new Map<string, DecodedGroup>();
  #cacheUsed = 0;
  #inflight = new Map<string, Promise<DecodedGroup>>();
  #toPixel: XYTransform = { sx: 1, sy: 1, tx: 0, ty: 0 };

  async init(
    spec: SourceSpec,
    parquetPath: string,
    toPixel: XYTransform,
    genes: string[],
  ): Promise<TranscriptsInit> {
    const started = performance.now();
    this.#source = createDataSource(spec);
    if (genes.length >= UNKNOWN_FEATURE) {
      throw new Error(`Too many genes to code as uint16: ${genes.length}`);
    }
    genes.forEach((gene, i) => this.#geneIndex.set(gene, i));

    const names = (await this.#source.listFiles(parquetPath))
      .filter((name) => name.endsWith(".parquet"))
      .sort((a, b) => partOrder(a) - partOrder(b));

    const paths = names.length
      ? names.map((name) => `${parquetPath}/${name}`)
      : // spatialdata writes a single file rather than a directory for small
        // point tables.
        [parquetPath];

    const opened = await Promise.all(paths.map((path) => this.#source.openFile(path)));
    this.#files = opened.filter((file): file is AsyncBuffer => file !== undefined);
    if (this.#files.length === 0) throw new Error(`No parquet parts under ${parquetPath}`);

    const metas = await Promise.all(this.#files.map((file) => parquetMetadataAsync(file)));

    let totalRows = 0;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    metas.forEach((meta: FileMetaData, part) => {
      let rowStart = 0;
      for (const group of meta.row_groups) {
        const rows = Number(group.num_rows);
        const bounds: Record<string, { min?: number; max?: number }> = {};
        for (const chunk of group.columns) {
          const name = chunk.meta_data?.path_in_schema.join(".");
          if (name !== "x" && name !== "y") continue;
          const stats = chunk.meta_data?.statistics;
          bounds[name] = {
            min: statBound(stats?.min_value ?? stats?.min),
            max: statBound(stats?.max_value ?? stats?.max),
          };
        }
        const bx = bounds.x;
        const by = bounds.y;
        if (bx?.min === undefined || bx.max === undefined) {
          throw new Error(
            "The transcripts parquet has no x/y statistics, so a viewport cannot be " +
              "resolved without reading all 7 GB. Re-write it with statistics enabled.",
          );
        }
        // Statistics are in micrometres; everything downstream is level-0 px.
        const entry: RowGroupEntry = {
          part,
          rowStart,
          rowEnd: rowStart + rows,
          rows,
          minX: bx.min * toPixel.sx + toPixel.tx,
          maxX: bx.max * toPixel.sx + toPixel.tx,
          minY: (by?.min ?? 0) * toPixel.sy + toPixel.ty,
          maxY: (by?.max ?? 0) * toPixel.sy + toPixel.ty,
        };
        this.#entries.push(entry);
        rowStart += rows;
        totalRows += rows;
        if (entry.minX < minX) minX = entry.minX;
        if (entry.minY < minY) minY = entry.minY;
        if (entry.maxX > maxX) maxX = entry.maxX;
        if (entry.maxY > maxY) maxY = entry.maxY;
      }
    });

    this.#toPixel = toPixel;
    return {
      parts: this.#files.length,
      rowGroups: this.#entries.length,
      totalRows,
      bounds: [minX, minY, maxX, maxY],
      elapsedMs: Math.round(performance.now() - started),
    };
  }

  async viewport(
    box: [number, number, number, number],
    maxPoints: number,
  ): Promise<ViewportPoints> {
    const [x0, y0, x1, y1] = box;

    // A linear scan, not a UniformGrid: there are only a few hundred row
    // groups, and their boxes range from a 250 µm sliver to the full height of
    // the slide, which breaks the grid's assumption that nothing is wider than
    // a bucket.
    const candidates: RowGroupEntry[] = [];
    let estimate = 0;
    for (const entry of this.#entries) {
      if (entry.minX > x1 || entry.maxX < x0 || entry.minY > y1 || entry.maxY < y0) continue;
      candidates.push(entry);
      // Scale by the overlapping fraction of the row group's box. Density is
      // near-uniform at that scale, and the alternative — counting whole row
      // groups — gates far too eagerly when the viewport clips a long one.
      const width = entry.maxX - entry.minX;
      const height = entry.maxY - entry.minY;
      const overlap =
        Math.max(0, Math.min(entry.maxX, x1) - Math.max(entry.minX, x0)) *
        Math.max(0, Math.min(entry.maxY, y1) - Math.max(entry.minY, y0));
      const area = width * height;
      estimate += area > 0 ? (entry.rows * overlap) / area : entry.rows;
    }
    if (estimate > maxPoints) return { tooMany: true, estimate: Math.round(estimate) };
    if (candidates.length === 0) {
      return Comlink.transfer(
        { tooMany: false as const, count: 0, total: 0, ...emptyPoints() },
        [],
      );
    }

    const groups = await Promise.all(candidates.map((entry) => this.#group(entry)));

    // Count first so the output buffers are allocated exactly; the compare loop
    // is cheap next to the parquet decode.
    let total = 0;
    for (const group of groups) {
      const { x, y } = group;
      for (let i = 0; i < x.length; i++) {
        if (x[i] >= x0 && x[i] <= x1 && y[i] >= y0 && y[i] <= y1) total++;
      }
    }

    const count = Math.min(total, maxPoints);
    const positions = new Float32Array(count * 2);
    const codes = new Uint16Array(count);
    let write = 0;
    outer: for (const group of groups) {
      const { x, y, codes: groupCodes } = group;
      for (let i = 0; i < x.length; i++) {
        if (x[i] < x0 || x[i] > x1 || y[i] < y0 || y[i] > y1) continue;
        if (write >= count) break outer;
        positions[write * 2] = x[i];
        positions[write * 2 + 1] = y[i];
        codes[write] = groupCodes[i];
        write++;
      }
    }

    return Comlink.transfer({ tooMany: false as const, count, total, positions, codes }, [
      positions.buffer,
      codes.buffer,
    ]);
  }

  #group(entry: RowGroupEntry): Promise<DecodedGroup> {
    const key = `${entry.part}:${entry.rowStart}`;
    const cached = this.#cache.get(key);
    if (cached) {
      // Refresh LRU position.
      this.#cache.delete(key);
      this.#cache.set(key, cached);
      return Promise.resolve(cached);
    }
    let pending = this.#inflight.get(key);
    if (!pending) {
      pending = this.#decode(entry)
        .then((group) => {
          this.#cache.set(key, group);
          this.#cacheUsed += group.bytes;
          this.#evict();
          return group;
        })
        .finally(() => this.#inflight.delete(key));
      this.#inflight.set(key, pending);
    }
    return pending;
  }

  #evict(): void {
    for (const [key, group] of this.#cache) {
      if (this.#cacheUsed <= CACHE_BYTES) return;
      this.#cache.delete(key);
      this.#cacheUsed -= group.bytes;
    }
  }

  async #decode(entry: RowGroupEntry): Promise<DecodedGroup> {
    const file = this.#files[entry.part];
    const length = entry.rows;
    const x = new Float32Array(length);
    const y = new Float32Array(length);
    const codes = new Uint16Array(length).fill(UNKNOWN_FEATURE);
    const { sx, sy, tx, ty } = this.#toPixel;

    await parquetRead({
      file,
      columns: ["x", "y", "feature_name"],
      rowStart: entry.rowStart,
      rowEnd: entry.rowEnd,
      // Same reasoning as the shapes reader: skip the GeoJSON conversion and
      // the blanket text decode. feature_name has a STRING logical type, so it
      // still comes back as strings.
      geoparquet: false,
      utf8: false,
      compressors,
      onChunk: (chunk) => {
        // hyparquet may hand back rows outside the requested range.
        const from = Math.max(chunk.rowStart, entry.rowStart);
        const to = Math.min(chunk.rowEnd, entry.rowEnd);
        const data = chunk.columnData as unknown as ArrayLike<number | string>;
        if (chunk.columnName === "x") {
          for (let row = from; row < to; row++) {
            x[row - entry.rowStart] = (data[row - chunk.rowStart] as number) * sx + tx;
          }
        } else if (chunk.columnName === "y") {
          for (let row = from; row < to; row++) {
            y[row - entry.rowStart] = (data[row - chunk.rowStart] as number) * sy + ty;
          }
        } else if (chunk.columnName === "feature_name") {
          for (let row = from; row < to; row++) {
            const name = data[row - chunk.rowStart] as string;
            codes[row - entry.rowStart] = this.#geneIndex.get(name) ?? UNKNOWN_FEATURE;
          }
        }
      },
    });

    return { x, y, codes, bytes: x.byteLength + y.byteLength + codes.byteLength };
  }
}

function emptyPoints() {
  return { positions: new Float32Array(0), codes: new Uint16Array(0) };
}

Comlink.expose(new TranscriptStore());

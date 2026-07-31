/// <reference lib="webworker" />
import * as Comlink from "comlink";
import * as zarr from "zarrita";
import type { TableElement, XMatrix } from "../data/dataset";
import { type SourceSpec, createDataSource } from "../data/stores";
import { extent, openArray, percentiles, readStringArray } from "./anndata";
import type { ColumnData } from "./cells.worker";

export interface ExpressionInit {
  genes: string[];
  nnz: number;
}

export interface MatrixSummary {
  nnz: number;
  /** Resident size of the matrix, for the console timing line. */
  bytes: number;
  /** False when a row's gene ids are not ascending, forcing linear lookups. */
  sorted: boolean;
  /** True when counts were compressed to bytes; false for the float fallback. */
  compact: boolean;
  elapsedMs: number;
}

export interface GeneCount {
  gene: string;
  count: number;
}

/**
 * See the note on `CellsWorkerApi` — property syntax throughout, so callers can
 * pull these off the remote without tripping `unbound-method`.
 */
export interface ExpressionWorkerApi {
  init: (spec: SourceSpec, table: TableElement) => Promise<ExpressionInit>;
  loadMatrix: (onProgress: (fraction: number) => void) => Promise<MatrixSummary>;
  geneValues: (gene: string) => Promise<ColumnData>;
  cellGenes: (cell: number, topK: number) => Promise<GeneCount[]>;
}

/**
 * Non-zeros read per round trip. Each `X` shard inner chunk is ~151k elements,
 * so this pulls a few dozen at a time: large enough that the per-request
 * overhead disappears, small enough that only one slice is ever live alongside
 * the resident arrays.
 */
const SLICE = 4_194_304;

/**
 * Counts at or above this are held in a side map instead of the byte array.
 * On the sample slide only 0.007% of non-zeros exceed 255, so the escape costs
 * a few thousand map entries and saves 460 MB against a float array.
 */
const COUNT_ESCAPE = 255;

/** Slices sampled to decide whether counts fit in a byte. */
const PROBE_SLICES = 3;

interface XArrays {
  data: zarr.Array<zarr.NumberDataType, zarr.AsyncReadable>;
  indices: zarr.Array<zarr.NumberDataType, zarr.AsyncReadable>;
  indptr: zarr.Array<zarr.NumberDataType, zarr.AsyncReadable>;
}

/**
 * `indptr` runs to the non-zero count — 154M on the sample slide — which a
 * Float32Array cannot represent exactly above 2^24. Always widen to Int32.
 */
function toInt32Array(data: unknown, length: number): Int32Array {
  const out = new Int32Array(length);
  if (data instanceof BigInt64Array || data instanceof BigUint64Array) {
    for (let i = 0; i < length; i++) out[i] = Number(data[i]);
  } else if (ArrayBuffer.isView(data)) {
    out.set(data as unknown as ArrayLike<number>);
  } else {
    const indexable = data as ArrayLike<number>;
    for (let i = 0; i < length; i++) out[i] = Number(indexable[i]);
  }
  return out;
}

/** Index of `gene` within `[from, to)` of an ascending run, or -1. */
function findGene(ids: Uint16Array | Uint32Array, from: number, to: number, gene: number): number {
  let lo = from;
  let hi = to - 1;
  while (lo <= hi) {
    const mid = lo + ((hi - lo) >> 1);
    const value = ids[mid];
    if (value < gene) lo = mid + 1;
    else if (value > gene) hi = mid - 1;
    else return mid;
  }
  return -1;
}

/**
 * Reads AnnData's `X` when it is CSR over cells.
 *
 * The matrix is held in the worker in a compact form (gene ids as uint16,
 * counts as bytes) so that colouring by a gene is a per-row binary search
 * rather than a re-read: ~17 ms for a whole column against ~2.7 s to stream
 * `indices` and `data` back out of the store. No CSC transpose is built —
 * because each row's gene ids are ascending, the search finds the column
 * directly.
 */
class ExpressionStore implements ExpressionWorkerApi {
  #store!: zarr.AsyncReadable;
  #x!: XMatrix;
  #genes: string[] = [];
  #geneIndex = new Map<string, number>();
  #arrays?: Promise<XArrays>;

  #indptr?: Int32Array;
  #geneIds?: Uint16Array | Uint32Array;
  /** Compact path: byte counts plus escapes. */
  #counts?: Uint8Array;
  #overflow = new Map<number, number>();
  /** Fallback path, used when values are not small integers. */
  #values?: Float32Array;
  #sorted = true;
  #pending?: Promise<MatrixSummary>;

  async init(spec: SourceSpec, table: TableElement): Promise<ExpressionInit> {
    this.#store = createDataSource(spec).store;
    if (!table.x) throw new Error("Table has no CSR X matrix");
    this.#x = table.x;

    const names = table.varIndexPath
      ? await readStringArray(this.#store, table.varIndexPath).catch(() => [])
      : [];
    // Fall back to positional names rather than mislabelling columns if var is
    // missing or does not line up with X.
    this.#genes =
      names.length === this.#x.nVar
        ? names
        : Array.from({ length: this.#x.nVar }, (_, i) => `Gene ${i + 1}`);
    this.#genes.forEach((gene, i) => this.#geneIndex.set(gene, i));

    return { genes: this.#genes, nnz: this.#x.nnz };
  }

  #open(): Promise<XArrays> {
    this.#arrays ??= (async () => {
      const [data, indices, indptr] = await Promise.all([
        openArray(this.#store, `${this.#x.path}/data`),
        openArray(this.#store, `${this.#x.path}/indices`),
        openArray(this.#store, `${this.#x.path}/indptr`),
      ]);
      return { data, indices, indptr } as XArrays;
    })();
    return this.#arrays;
  }

  loadMatrix(onProgress: (fraction: number) => void): Promise<MatrixSummary> {
    this.#pending ??= this.#readMatrix(onProgress);
    return this.#pending;
  }

  async #readMatrix(onProgress: (fraction: number) => void): Promise<MatrixSummary> {
    const started = performance.now();
    const arrays = await this.#open();
    const { nnz, nObs, nVar } = this.#x;

    const indptr = toInt32Array((await zarr.get(arrays.indptr, [null])).data, nObs + 1);

    // Gene ids index the columns of X, so uint16 covers any panel up to 65535
    // genes; wider matrices fall back to uint32 rather than silently wrapping.
    const geneIds = nVar <= 65535 ? new Uint16Array(nnz) : new Uint32Array(nnz);
    const compact = await this.#countsFitInBytes(arrays);
    const counts = compact ? new Uint8Array(nnz) : undefined;
    const values = compact ? undefined : new Float32Array(nnz);
    const overflow = new Map<number, number>();

    for (let start = 0; start < nnz; start += SLICE) {
      const end = Math.min(start + SLICE, nnz);
      const [idxChunk, dataChunk] = await Promise.all([
        zarr.get(arrays.indices, [zarr.slice(start, end)]),
        zarr.get(arrays.data, [zarr.slice(start, end)]),
      ]);
      const ids = idxChunk.data as unknown as ArrayLike<number>;
      const vals = dataChunk.data as unknown as ArrayLike<number>;
      const length = end - start;

      if (counts) {
        for (let i = 0; i < length; i++) {
          geneIds[start + i] = ids[i];
          const value = vals[i];
          if (value >= COUNT_ESCAPE) {
            counts[start + i] = COUNT_ESCAPE;
            overflow.set(start + i, value);
          } else {
            counts[start + i] = value;
          }
        }
      } else {
        for (let i = 0; i < length; i++) {
          geneIds[start + i] = ids[i];
          values![start + i] = vals[i];
        }
      }
      onProgress(end / nnz);
    }

    this.#indptr = indptr;
    this.#geneIds = geneIds;
    this.#counts = counts;
    this.#values = values;
    this.#overflow = overflow;
    this.#sorted = this.#checkSorted(indptr, geneIds, nObs);

    const bytes =
      indptr.byteLength +
      geneIds.byteLength +
      (counts?.byteLength ?? values?.byteLength ?? 0) +
      overflow.size * 16;
    return {
      nnz,
      bytes,
      sorted: this.#sorted,
      compact,
      elapsedMs: Math.round(performance.now() - started),
    };
  }

  /**
   * Samples `data` to decide the storage mode. Xenium writes raw counts as
   * float32, which pack into bytes; a normalised or log-transformed matrix does
   * not, and truncating it would silently corrupt every colour.
   */
  async #countsFitInBytes(arrays: XArrays): Promise<boolean> {
    const { nnz } = this.#x;
    const span = Math.min(SLICE, nnz);
    for (let probe = 0; probe < PROBE_SLICES; probe++) {
      const start = Math.floor(((nnz - span) * probe) / Math.max(1, PROBE_SLICES - 1));
      const chunk = await zarr.get(arrays.data, [zarr.slice(start, start + span)]);
      const vals = chunk.data as unknown as ArrayLike<number>;
      for (let i = 0; i < span; i++) {
        const value = vals[i];
        if (value < 0 || !Number.isInteger(value)) return false;
      }
    }
    return true;
  }

  /**
   * Confirms each row's gene ids ascend, which is what makes the binary search
   * in `geneValues` correct. Canonical scipy/AnnData CSR is sorted, but a
   * hand-written store need not be, and an unnoticed violation would return
   * zeros for genes that are present.
   */
  #checkSorted(indptr: Int32Array, ids: Uint16Array | Uint32Array, nObs: number): boolean {
    for (let cell = 0; cell < nObs; cell++) {
      const to = indptr[cell + 1];
      for (let k = indptr[cell] + 1; k < to; k++) {
        if (ids[k] <= ids[k - 1]) return false;
      }
    }
    return true;
  }

  #valueAt(k: number): number {
    if (this.#values) return this.#values[k];
    const value = this.#counts![k];
    return value === COUNT_ESCAPE ? (this.#overflow.get(k) ?? COUNT_ESCAPE) : value;
  }

  async geneValues(gene: string): Promise<ColumnData> {
    // A load kicked off by an earlier call may still be running.
    await this.#pending;
    const column = this.#geneIndex.get(gene);
    if (column === undefined) throw new Error(`No gene named "${gene}"`);
    const indptr = this.#indptr;
    const ids = this.#geneIds;
    if (!indptr || !ids) throw new Error("The expression matrix has not been loaded");

    const n = this.#x.nObs;
    const values = new Float32Array(n);
    for (let cell = 0; cell < n; cell++) {
      const from = indptr[cell];
      const to = indptr[cell + 1];
      let k = -1;
      if (this.#sorted) {
        k = findGene(ids, from, to, column);
      } else {
        for (let i = from; i < to; i++) {
          if (ids[i] === column) {
            k = i;
            break;
          }
        }
      }
      if (k >= 0) values[cell] = this.#valueAt(k);
    }

    const { min, max } = extent(values);
    return Comlink.transfer(
      { kind: "numeric" as const, values, min, max, ...percentiles(values, min, max) },
      [values.buffer],
    );
  }

  /**
   * The genes expressed in one cell, highest first.
   *
   * A CSR row is contiguous, so this works straight off the store without the
   * matrix being resident — the sharding codec turns it into a single ~600 KB
   * chunk fetch, ~6 ms. That keeps the inspector useful the moment a cell is
   * clicked, with no wait on `loadMatrix`.
   */
  async cellGenes(cell: number, topK: number): Promise<GeneCount[]> {
    if (cell < 0 || cell >= this.#x.nObs) return [];

    let ids: ArrayLike<number>;
    let read: (i: number) => number;
    let length: number;

    if (this.#indptr && this.#geneIds) {
      const from = this.#indptr[cell];
      const to = this.#indptr[cell + 1];
      length = to - from;
      ids = this.#geneIds.subarray(from, to);
      read = (i) => this.#valueAt(from + i);
    } else {
      const arrays = await this.#open();
      const ptr = await zarr.get(arrays.indptr, [zarr.slice(cell, cell + 2)]);
      const from = Number((ptr.data as unknown as ArrayLike<number>)[0]);
      const to = Number((ptr.data as unknown as ArrayLike<number>)[1]);
      length = to - from;
      if (length <= 0) return [];
      const [idxChunk, dataChunk] = await Promise.all([
        zarr.get(arrays.indices, [zarr.slice(from, to)]),
        zarr.get(arrays.data, [zarr.slice(from, to)]),
      ]);
      ids = idxChunk.data;
      const vals = dataChunk.data as unknown as ArrayLike<number>;
      read = (i) => vals[i];
    }
    if (length <= 0) return [];

    const order = Array.from({ length }, (_, i) => i);
    order.sort((a, b) => read(b) - read(a));
    return order.slice(0, topK).map((i) => ({
      gene: this.#genes[ids[i]] ?? String(ids[i]),
      count: read(i),
    }));
  }
}

Comlink.expose(new ExpressionStore());

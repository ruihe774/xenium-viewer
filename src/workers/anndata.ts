import * as zarr from "zarrita";

/** Opens an array in a store by path relative to the root. */
export function openArray(store: zarr.AsyncReadable, path: string) {
  return zarr.open(zarr.root(store).resolve(path), { kind: "array" });
}

/** Reads AnnData's string-ish encodings into a plain array of strings. */
export function toStringArray(data: unknown, length: number): string[] {
  if (Array.isArray(data)) return data as string[];
  const out = new Array<string>(length);
  const indexable = data as { get(i: number): unknown };
  for (let i = 0; i < length; i++) out[i] = String(indexable.get(i));
  return out;
}

/**
 * Reads a string array, transparently handling AnnData's
 * `nullable-string-array` layout (a `values` child plus a `mask`).
 *
 * Used for obs columns, cell ids and `var/_index` gene names alike — they all
 * share this encoding.
 */
export async function readStringArray(store: zarr.AsyncReadable, path: string): Promise<string[]> {
  const arr = await openArray(store, `${path}/values`).catch(() => openArray(store, path));
  const { data, shape } = await zarr.get(arr);
  return toStringArray(data, shape[0]);
}

export function toNumberArray(data: unknown, length: number): Float32Array {
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

const PERCENTILE_BINS = 2048;

/**
 * Percentile bounds from a histogram.
 *
 * Xenium obs columns and gene counts alike have long tails — most cells hold
 * zero of any given gene — so a min/max colour range leaves almost every cell
 * at the bottom of the ramp.
 */
export function percentiles(values: Float32Array, min: number, max: number) {
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

/** Min and max of a numeric column, ignoring nothing. */
export function extent(values: Float32Array): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < values.length; i++) {
    if (values[i] < min) min = values[i];
    if (values[i] > max) max = values[i];
  }
  return { min, max };
}

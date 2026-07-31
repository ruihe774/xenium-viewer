/// <reference lib="webworker" />
import * as Comlink from "comlink";
import * as zarr from "zarrita";
import { type SourceSpec, createDataSource } from "../data/stores";

export interface TileData {
  data: Uint16Array;
  width: number;
  height: number;
}

export interface ChannelStats {
  min: number;
  max: number;
  /** Bin counts over `[min, max]`, for the contrast widget. */
  histogram: number[];
  /** Sensible initial contrast window, from the intensity distribution. */
  contrastLimits: [number, number];
  /** Small nearest-neighbour downsample of the whole channel, for the minimap. */
  thumbnail: TileData;
}

/** Longest edge of the minimap thumbnail, in pixels. */
const THUMBNAIL_MAX = 256;

function downsample(data: Uint16Array, width: number, height: number, maxEdge: number): TileData {
  const step = Math.max(1, Math.ceil(Math.max(width, height) / maxEdge));
  const outWidth = Math.ceil(width / step);
  const outHeight = Math.ceil(height / step);
  const out = new Uint16Array(outWidth * outHeight);
  for (let y = 0; y < outHeight; y++) {
    const src = Math.min(height - 1, y * step) * width;
    for (let x = 0; x < outWidth; x++) {
      out[y * outWidth + x] = data[src + Math.min(width - 1, x * step)];
    }
  }
  return { data: out, width: outWidth, height: outHeight };
}

export interface ImageWorkerApi {
  init: (
    spec: SourceSpec,
    levelPaths: string[],
    axes: string[],
    cacheBytes: number,
  ) => Promise<void>;
  getTile: (
    level: number,
    c: number,
    tx: number,
    ty: number,
    tileSize: number,
  ) => Promise<TileData>;
  channelStats: (level: number, c: number) => Promise<ChannelStats>;
}

const HISTOGRAM_BINS = 256;

/**
 * Intensity distribution of one channel at one pyramid level.
 *
 * Fluorescence channels are dominated by near-zero background, so a plain
 * min/max window renders almost black. The default window instead runs from a
 * low percentile to the 99.9th, which is roughly what Xenium Explorer shows on
 * first open.
 */
function computeStats(data: Uint16Array, width: number, height: number): ChannelStats {
  const thumbnail = downsample(data, width, height, THUMBNAIL_MAX);
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min)) min = 0;
  if (max <= min) {
    return { min, max, histogram: [], contrastLimits: [min, min + 1], thumbnail };
  }

  const histogram = new Array<number>(HISTOGRAM_BINS).fill(0);
  const scale = HISTOGRAM_BINS / (max - min + 1);
  for (let i = 0; i < data.length; i++) {
    histogram[((data[i] - min) * scale) | 0]++;
  }

  const percentile = (p: number) => {
    let seen = 0;
    const target = data.length * p;
    for (let b = 0; b < HISTOGRAM_BINS; b++) {
      seen += histogram[b];
      if (seen >= target) return min + ((b + 1) / HISTOGRAM_BINS) * (max - min);
    }
    return max;
  };

  const low = percentile(0.5);
  const high = Math.max(percentile(0.999), low + 1);
  return {
    min,
    max,
    histogram,
    contrastLimits: [Math.round(low), Math.round(high)],
    thumbnail,
  };
}

type Chunk = { data: zarr.TypedArray<"uint16">; shape: number[]; stride: number[] };

/**
 * Serves image tiles out of a zarr pyramid, caching *decoded* chunks.
 *
 * Xenium chunks are 4096x4096 uint16 (33.5 MB decoded) and zstd-compressed, so
 * decoding is by far the dominant cost. Tiles are smaller than a chunk, which
 * means one decode typically serves many tiles — hence the cache lives here,
 * next to the decoder, rather than on the main thread.
 */
class ImageTileServer implements ImageWorkerApi {
  #arrays: zarr.Array<"uint16">[] = [];
  #axes = { c: 0, y: 1, x: 2 };
  #cacheBytes = 128 * 1024 * 1024;
  /** Insertion-ordered, so the oldest entry is always first — a plain LRU. */
  #cache = new Map<string, Chunk>();
  #cacheUsed = 0;
  #inflight = new Map<string, Promise<Chunk>>();

  async init(spec: SourceSpec, levelPaths: string[], axes: string[], cacheBytes: number) {
    const { store } = createDataSource(spec);
    this.#axes = { c: axes.indexOf("c"), y: axes.indexOf("y"), x: axes.indexOf("x") };
    this.#cacheBytes = cacheBytes;
    this.#arrays = await Promise.all(
      levelPaths.map((path) =>
        zarr.open(zarr.root(store).resolve(path), { kind: "array" }).then((arr) => {
          if (!arr.is("uint16")) {
            throw new Error(`${path} has dtype ${arr.dtype}; only uint16 images are supported`);
          }
          return arr;
        }),
      ),
    );
  }

  #chunk(level: number, coords: number[]): Promise<Chunk> {
    const key = `${level}/${coords.join(",")}`;
    const hit = this.#cache.get(key);
    if (hit) {
      // Refresh recency.
      this.#cache.delete(key);
      this.#cache.set(key, hit);
      return Promise.resolve(hit);
    }
    let pending = this.#inflight.get(key);
    if (!pending) {
      pending = this.#arrays[level]
        .getChunk(coords)
        .then((chunk) => {
          this.#cache.set(key, chunk);
          this.#cacheUsed += chunk.data.byteLength;
          for (const [oldest, value] of this.#cache) {
            if (this.#cacheUsed <= this.#cacheBytes) break;
            if (oldest === key) continue; // never evict what we just fetched
            this.#cache.delete(oldest);
            this.#cacheUsed -= value.data.byteLength;
          }
          return chunk;
        })
        .finally(() => this.#inflight.delete(key));
      this.#inflight.set(key, pending);
    }
    return pending;
  }

  async getTile(level: number, c: number, tx: number, ty: number, tileSize: number) {
    const arr = this.#arrays[level];
    const { x: xi, y: yi, c: ci } = this.#axes;
    const imageWidth = arr.shape[xi];
    const imageHeight = arr.shape[yi];
    const x0 = tx * tileSize;
    const y0 = ty * tileSize;
    if (x0 >= imageWidth || y0 >= imageHeight) {
      return { data: new Uint16Array(0), width: 0, height: 0 };
    }
    const width = Math.min(tileSize, imageWidth - x0);
    const height = Math.min(tileSize, imageHeight - y0);
    const out = new Uint16Array(width * height);

    const chunkHeight = arr.chunks[yi];
    const chunkWidth = arr.chunks[xi];
    const reads: Promise<void>[] = [];
    for (
      let cy = Math.floor(y0 / chunkHeight);
      cy <= Math.floor((y0 + height - 1) / chunkHeight);
      cy++
    ) {
      for (
        let cx = Math.floor(x0 / chunkWidth);
        cx <= Math.floor((x0 + width - 1) / chunkWidth);
        cx++
      ) {
        const coords = new Array<number>(arr.shape.length).fill(0);
        // Channel chunking is [1, ...] in practice, but don't assume it.
        const channelInChunk = ci >= 0 ? c % arr.chunks[ci] : 0;
        if (ci >= 0) coords[ci] = Math.floor(c / arr.chunks[ci]);
        coords[yi] = cy;
        coords[xi] = cx;
        // Region of this chunk that overlaps the tile, in image coordinates.
        const sy = Math.max(y0, cy * chunkHeight);
        const ey = Math.min(y0 + height, (cy + 1) * chunkHeight);
        const sx = Math.max(x0, cx * chunkWidth);
        const ex = Math.min(x0 + width, (cx + 1) * chunkWidth);
        reads.push(
          this.#chunk(level, coords).then((chunk) => {
            const rowStride = chunk.stride[yi];
            const colStride = chunk.stride[xi];
            const base = ci >= 0 ? channelInChunk * chunk.stride[ci] : 0;
            for (let y = sy; y < ey; y++) {
              const src = base + (y - cy * chunkHeight) * rowStride;
              const dst = (y - y0) * width;
              if (colStride === 1) {
                out.set(
                  chunk.data.subarray(src + (sx - cx * chunkWidth), src + (ex - cx * chunkWidth)),
                  dst + (sx - x0),
                );
              } else {
                for (let x = sx; x < ex; x++) {
                  out[dst + (x - x0)] = chunk.data[src + (x - cx * chunkWidth) * colStride];
                }
              }
            }
          }),
        );
      }
    }
    await Promise.all(reads);
    return Comlink.transfer({ data: out, width, height }, [out.buffer]);
  }

  async channelStats(level: number, c: number): Promise<ChannelStats> {
    const arr = this.#arrays[level];
    const { c: ci, x: xi, y: yi } = this.#axes;
    const selection: (number | null)[] = new Array<null>(arr.shape.length).fill(null);
    if (ci >= 0) selection[ci] = c;
    const result = await zarr.get(arr, selection);
    const stats = computeStats(result.data, arr.shape[xi], arr.shape[yi]);
    return Comlink.transfer(stats, [stats.thumbnail.data.buffer]);
  }
}

Comlink.expose(new ImageTileServer());

import * as Comlink from "comlink";
import type { ImageElement } from "../data/dataset";
import type { SourceSpec } from "../data/stores";
import type { ChannelStats, ImageWorkerApi, TileData } from "../workers/image.worker";
import ImageWorker from "../workers/image.worker?worker";

/**
 * Viv's `PixelSource` contract, reproduced so we don't import from @vivjs/types.
 *
 * `getRaster` is deliberately absent: Viv only calls it to build the full-level
 * backdrop layer, which the viewer disables via `excludeBackground`. Leaving it
 * off also stops Viv re-adding that layer by feature detection.
 */
export interface PixelSource {
  labels: string[];
  tileSize: number;
  shape: number[];
  dtype: "Uint16";
  getTile(sel: {
    x: number;
    y: number;
    selection: { c: number };
    signal?: AbortSignal;
  }): Promise<TileData>;
  onTileError(err: Error): void;
}

/** Thrown when a tile request is superseded; Viv swallows this exact value. */
export const SIGNAL_ABORTED = "__vivSignalAborted";

const TILE_SIZE = 1024;
/** Total decoded-chunk cache across the pool. Chunks are 33.5 MB each. */
const CHUNK_CACHE_BYTES = 512 * 1024 * 1024;
const WORKER_COUNT = 3;

/**
 * A pool of decode workers plus the `PixelSource[]` pyramid Viv consumes.
 *
 * Requests are routed to a worker by the *chunk* they land in, so a given chunk
 * is decoded and cached in exactly one worker. Round-robin would instead
 * duplicate 33.5 MB chunks across every worker.
 */
export class ImagePyramid {
  #workers: Worker[] = [];
  #apis: Comlink.Remote<ImageWorkerApi>[] = [];
  #ready: Promise<unknown>;
  readonly levels: PixelSource[];
  readonly image: ImageElement;

  constructor(spec: SourceSpec, image: ImageElement) {
    this.image = image;
    const levelPaths = image.levels.map((l) => l.path);
    for (let i = 0; i < WORKER_COUNT; i++) {
      const worker = new ImageWorker();
      this.#workers.push(worker);
      this.#apis.push(Comlink.wrap<ImageWorkerApi>(worker));
    }
    this.#ready = Promise.all(
      this.#apis.map((api) =>
        api.init(spec, levelPaths, image.axes, Math.floor(CHUNK_CACHE_BYTES / WORKER_COUNT)),
      ),
    );

    const xi = image.axes.indexOf("x");
    const yi = image.axes.indexOf("y");
    this.levels = image.levels.map((level, index) => {
      const chunkWidth = level.chunkShape[xi];
      const chunkHeight = level.chunkShape[yi];
      return {
        labels: image.axes,
        tileSize: TILE_SIZE,
        shape: level.shape,
        dtype: "Uint16" as const,
        getTile: async ({ x, y, selection, signal }) => {
          await this.#ready;
          const worker = this.#route(
            index,
            selection.c,
            Math.floor((x * TILE_SIZE) / chunkWidth),
            Math.floor((y * TILE_SIZE) / chunkHeight),
          );
          const tile = await worker.getTile(index, selection.c, x, y, TILE_SIZE);
          if (signal?.aborted) throw SIGNAL_ABORTED;
          return tile;
        },
        onTileError: (err: Error) => {
          console.error("tile error", err);
        },
      } satisfies PixelSource;
    });
  }

  #route(level: number, c: number, cx: number, cy: number): Comlink.Remote<ImageWorkerApi> {
    // Cheap spatial hash — adjacent chunks land on different workers so a single
    // viewport's decodes run in parallel.
    const hash = level * 31 + c * 17 + cx * 7 + cy * 3;
    return this.#apis[((hash % WORKER_COUNT) + WORKER_COUNT) % WORKER_COUNT];
  }

  /** Intensity stats from the smallest pyramid level, for auto-contrast. */
  async channelStats(c: number): Promise<ChannelStats> {
    await this.#ready;
    return this.#apis[c % WORKER_COUNT].channelStats(this.levels.length - 1, c);
  }

  destroy() {
    for (const worker of this.#workers) worker.terminate();
    this.#workers = [];
    this.#apis = [];
  }
}

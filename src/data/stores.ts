import type { AbsolutePath, AsyncReadable, RangeQuery } from "zarrita";
import { FetchStore } from "zarrita";

/**
 * Where a dataset lives. Both variants are structured-cloneable so the same
 * spec can be handed to a worker and re-opened there.
 */
export type SourceSpec =
  | { kind: "fs"; handle: FileSystemDirectoryHandle; name: string }
  | { kind: "http"; url: string; name: string };

/** Minimal random-access file interface, matching hyparquet's `AsyncBuffer`. */
export interface AsyncBuffer {
  byteLength: number;
  slice: (start: number, end?: number) => Promise<ArrayBuffer>;
}

function splitKey(key: string): string[] {
  return key.split("/").filter(Boolean);
}

/**
 * A zarrita store backed by a `FileSystemDirectoryHandle` from
 * `showDirectoryPicker()`.
 *
 * Chunk keys look like `/images/morphology_focus/s0/c/0/12/7`, so a naive
 * `getDirectoryHandle` walk would re-resolve the same five directories for
 * every chunk. Resolved directories are memoized (as promises, so concurrent
 * misses share one lookup).
 */
export class FileSystemStore implements AsyncReadable {
  #root: FileSystemDirectoryHandle;
  #dirs = new Map<string, Promise<FileSystemDirectoryHandle | undefined>>();

  constructor(root: FileSystemDirectoryHandle) {
    this.#root = root;
  }

  #dir(parts: string[]): Promise<FileSystemDirectoryHandle | undefined> {
    const path = parts.join("/");
    let pending = this.#dirs.get(path);
    if (!pending) {
      pending = (async () => {
        if (parts.length === 0) return this.#root;
        const parent = await this.#dir(parts.slice(0, -1));
        if (!parent) return undefined;
        try {
          return await parent.getDirectoryHandle(parts[parts.length - 1]);
        } catch {
          return undefined;
        }
      })();
      this.#dirs.set(path, pending);
    }
    return pending;
  }

  async #file(key: string): Promise<File | undefined> {
    const parts = splitKey(key);
    if (parts.length === 0) return undefined;
    const dir = await this.#dir(parts.slice(0, -1));
    if (!dir) return undefined;
    try {
      const handle = await dir.getFileHandle(parts[parts.length - 1]);
      return await handle.getFile();
    } catch {
      // Missing chunks are normal in zarr — they mean "fill value".
      return undefined;
    }
  }

  async get(key: AbsolutePath): Promise<Uint8Array | undefined> {
    const file = await this.#file(key);
    if (!file) return undefined;
    return new Uint8Array(await file.arrayBuffer());
  }

  async getRange(key: AbsolutePath, range: RangeQuery): Promise<Uint8Array | undefined> {
    const file = await this.#file(key);
    if (!file) return undefined;
    const [start, end] =
      "suffixLength" in range
        ? [Math.max(0, file.size - range.suffixLength), file.size]
        : [range.offset, range.offset + range.length];
    return new Uint8Array(await file.slice(start, end).arrayBuffer());
  }

  async openFile(path: string): Promise<AsyncBuffer | undefined> {
    const file = await this.#file(path);
    if (!file) return undefined;
    return {
      byteLength: file.size,
      slice: (start, end) => file.slice(start, end ?? file.size).arrayBuffer(),
    };
  }

  /** Direct filenames under `path`, used to enumerate multi-part parquet dirs. */
  async listFiles(path: string): Promise<string[]> {
    const dir = await this.#dir(splitKey(path));
    if (!dir) return [];
    const names: string[] = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === "file") names.push(name);
    }
    return names.sort();
  }
}

/** A zarrita store plus the extra file access the parquet readers need. */
export interface DataSource {
  spec: SourceSpec;
  store: AsyncReadable;
  /** Opens a non-zarr file (e.g. `shapes/cell_boundaries/shapes.parquet`). */
  openFile: (path: string) => Promise<AsyncBuffer | undefined>;
}

/** zarrita's FetchStore needs an absolute URL, so resolve relative ones here. */
export function normalizeUrl(url: string): string {
  const absolute = new URL(url, self.location.href).href;
  return absolute.endsWith("/") ? absolute.slice(0, -1) : absolute;
}

async function openHttpFile(base: string, path: string): Promise<AsyncBuffer | undefined> {
  const url = `${base}/${path.replace(/^\//, "")}`;
  const head = await fetch(url, { method: "HEAD" });
  if (!head.ok) return undefined;
  const length = Number(head.headers.get("content-length"));
  if (!Number.isFinite(length)) {
    throw new Error(`${url} did not report a Content-Length; ranged reads are not possible`);
  }
  return {
    byteLength: length,
    async slice(start, end) {
      const last = (end ?? length) - 1;
      const res = await fetch(url, { headers: { Range: `bytes=${start}-${last}` } });
      if (!res.ok) throw new Error(`Range request failed for ${url}: ${res.status}`);
      return res.arrayBuffer();
    },
  };
}

export function createDataSource(spec: SourceSpec): DataSource {
  if (spec.kind === "fs") {
    const store = new FileSystemStore(spec.handle);
    return { spec, store, openFile: (path) => store.openFile(path) };
  }
  const base = normalizeUrl(spec.url);
  return {
    spec,
    store: new FetchStore(base),
    openFile: (path) => openHttpFile(base, path),
  };
}

/** Reads and JSON-parses a file from the source. Returns undefined if absent. */
export async function readJson<T>(source: DataSource, key: AbsolutePath): Promise<T | undefined> {
  const bytes = await source.store.get(key);
  if (!bytes) return undefined;
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

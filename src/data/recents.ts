import type { CellColoring } from "../store";
import { normalizeUrl, type SourceSpec } from "./stores";

/**
 * Display preferences that survive a reload, attached to a `RecentRecord`.
 *
 * Only user choices are stored — never the derived data (histograms,
 * thumbnails, per-cell colours), which is both large and cheap to recompute.
 */
export interface StoredSettings {
  channels?: {
    visible: boolean;
    color: [number, number, number];
    contrastLimits: [number, number];
  }[];
  showCells?: boolean;
  showCellBoundaries?: boolean;
  showNucleusBoundaries?: boolean;
  boundaryStyle?: "outline" | "fill" | "both";
  cellOpacity?: number;
  imageOpacity?: number;
  cellColoring?: CellColoring;
}

/**
 * A previously opened store, keyed by an opaque id rather than by name, so
 * two different folders sharing a basename never collide (the old
 * `localStorage` scheme's bug). Holds the handle needed to reopen it with no
 * picker, plus the view options last saved for it.
 */
export interface RecentRecord {
  id: string;
  kind: "fs" | "http";
  /** Display label: `handle.name` or the URL's basename. */
  name: string;
  handle?: FileSystemDirectoryHandle;
  url?: string;
  /** Epoch ms of the most recent open. */
  lastOpened: number;
  settings: StoredSettings;
}

const DB_NAME = "xenium-viewer";
const DB_VERSION = 1;
const STORE = "recents";

let dbPromise: Promise<IDBDatabase> | undefined;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
  return dbPromise;
}

/** Runs `fn` against the object store inside a transaction, as a promise. */
async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

/** All saved records, newest first. Never throws — a broken DB reads as empty. */
export async function listRecents(): Promise<RecentRecord[]> {
  try {
    const all = await withStore<RecentRecord[]>(
      "readonly",
      (s) => s.getAll() as IDBRequest<RecentRecord[]>,
    );
    return all.sort((a, b) => b.lastOpened - a.lastOpened);
  } catch {
    return [];
  }
}

async function findExisting(spec: SourceSpec): Promise<RecentRecord | undefined> {
  const all = await listRecents();
  if (spec.kind === "http") {
    const target = normalizeUrl(spec.url);
    return all.find(
      (r) => r.kind === "http" && r.url !== undefined && normalizeUrl(r.url) === target,
    );
  }
  for (const r of all) {
    if (r.kind !== "fs" || !r.handle) continue;
    // `isSameEntry` is the only reliable identity for a directory handle —
    // two picks of the same folder are not `===` equal, and names collide.
    if (await r.handle.isSameEntry(spec.handle)) return r;
  }
  return undefined;
}

/**
 * Finds or creates the record for `spec`, bumps `lastOpened`, and (for `fs`)
 * stores the freshly picked handle so the live permission grant is retained.
 * Never throws — a storage failure falls back to an ephemeral in-memory
 * record with empty settings, so opening a dataset is never blocked.
 */
export async function touchRecent(spec: SourceSpec): Promise<RecentRecord> {
  try {
    const existing = await findExisting(spec);
    const record: RecentRecord = {
      id: existing?.id ?? crypto.randomUUID(),
      kind: spec.kind,
      name: spec.name,
      handle: spec.kind === "fs" ? spec.handle : undefined,
      url: spec.kind === "http" ? spec.url : undefined,
      lastOpened: Date.now(),
      settings: existing?.settings ?? {},
    };
    await withStore("readwrite", (s) => s.put(record));
    return record;
  } catch {
    return {
      id: crypto.randomUUID(),
      kind: spec.kind,
      name: spec.name,
      lastOpened: Date.now(),
      settings: {},
    };
  }
}

/** Merges `settings` into the record's saved preferences. */
export async function saveRecentSettings(id: string, settings: StoredSettings): Promise<void> {
  try {
    const existing = await withStore<RecentRecord | undefined>(
      "readonly",
      (s) => s.get(id) as IDBRequest<RecentRecord | undefined>,
    );
    if (!existing) return;
    await withStore("readwrite", (s) => s.put({ ...existing, settings }));
  } catch {
    // Quota or private-mode failures are not worth surfacing.
  }
}

/** Forgets a record entirely: the handle and its saved preferences alike. */
export async function deleteRecent(id: string): Promise<void> {
  try {
    await withStore("readwrite", (s) => s.delete(id));
  } catch {
    // Nothing useful to do if the delete itself fails.
  }
}

import { create } from "zustand";
import { CellsClient, type ColumnData } from "./data/cells";
import { type Dataset, loadDataset } from "./data/dataset";
import { saveRecentSettings, touchRecent, type StoredSettings } from "./data/recents";
import { type DataSource, type SourceSpec, createDataSource } from "./data/stores";
import { categoryColor, sampleColormap } from "./ui/colormaps";

export interface ChannelSettings {
  visible: boolean;
  color: [number, number, number];
  contrastLimits: [number, number];
  /** Full intensity range of the channel, used to bound the contrast slider. */
  domain: [number, number];
  /** Bin counts over `domain`, drawn behind the contrast slider. */
  histogram: number[];
  /** Small whole-slide downsample, composited into the minimap. */
  thumbnail?: { data: Uint16Array; width: number; height: number };
}

/** Colours Xenium Explorer uses for the standard morphology channels. */
const DEFAULT_CHANNEL_COLORS: [number, number, number][] = [
  [80, 130, 255], // DAPI — blue
  [0, 255, 140], // boundary stain — green
  [255, 120, 0], // 18S — orange
  [255, 60, 160], // alphaSMA/Vimentin — magenta
  [255, 255, 255],
  [255, 230, 0],
];

export type LoadStatus = "idle" | "loading" | "ready" | "error";

/**
 * How the cells layer is coloured. `column` names an obs column; `group` names
 * an imported cell-group set. They are separate modes because the two
 * namespaces can collide — a file may well be called `segmentation_method`.
 */
export interface CellColoring {
  mode: "uniform" | "column" | "group";
  column?: string;
  colormap: string;
  /** Value window for numeric columns; ignored for categorical ones. */
  range?: [number, number];
}

/** An imported cell-group assignment file. */
export interface GroupSet {
  name: string;
  categories: string[];
  counts: number[];
  colors: ([number, number, number] | null)[];
  matched: number;
  unmatched: number;
  /** Categories the user has hidden; hidden cells are not drawn. */
  hidden: string[];
}

export interface CellsState {
  status: LoadStatus;
  error?: string;
  n: number;
  positions?: Float32Array;
  /** Per-cell RGB, derived from `coloring`. */
  colors?: Uint8Array;
  columnData?: ColumnData;
  /** Table index (cell id) strings, loaded lazily after centroids are ready. */
  ids?: string[];
}

export interface AppState {
  status: LoadStatus;
  error?: string;
  source?: DataSource;
  dataset?: Dataset;
  /** IndexedDB id of the recent record backing the open dataset's settings. */
  recentId?: string;
  channels: ChannelSettings[];
  imageOpacity: number;
  /** Current orthographic zoom, mirrored here for the scale bar and readouts. */
  viewZoom: number;

  cellsClient?: CellsClient;
  cells: CellsState;
  showCells: boolean;
  showCellBoundaries: boolean;
  showNucleusBoundaries: boolean;
  boundaryStyle: "outline" | "fill" | "both";
  cellOpacity: number;
  cellColoring: CellColoring;
  uniformCellColor: [number, number, number];
  /** Imported cell-group files, in the order they were added. */
  groupSets: GroupSet[];
  groupImportError?: string;
  groupImporting: boolean;
  selectedCell?: number;
  cellDetails?: Record<string, string>;
  /** Mirrored from the viewer so the panel can report boundary progress. */
  boundaryStatus: BoundaryStatus;
  /** False once contrast comes from saved settings rather than the data. */
  autoContrast: boolean;

  open: (spec: SourceSpec) => Promise<void>;
  setChannel: (index: number, patch: Partial<ChannelSettings>) => void;
  setImageOpacity: (value: number) => void;
  setViewZoom: (zoom: number) => void;
  setShowCells: (value: boolean) => void;
  setShowCellBoundaries: (value: boolean) => void;
  setShowNucleusBoundaries: (value: boolean) => void;
  setBoundaryStyle: (value: "outline" | "fill" | "both") => void;
  setBoundaryStatus: (value: BoundaryStatus) => void;
  setCellOpacity: (value: number) => void;
  setCellColoring: (patch: Partial<CellColoring>) => Promise<void>;
  importGroupFiles: (files: File[]) => Promise<void>;
  removeGroupSet: (name: string) => Promise<void>;
  toggleGroupCategory: (name: string, category: string) => void;
  setGroupCategoriesHidden: (name: string, hidden: string[]) => void;
  selectCell: (index?: number) => Promise<void>;
  reset: () => void;
}

export interface BoundaryStatus {
  loading: boolean;
  /** Viewport holds more polygons than we draw. */
  tooMany: boolean;
  /** Whether centroid dots are currently standing in for boundaries. */
  dotsVisible: boolean;
  error?: string;
  count: number;
}

const IDLE_CELLS: CellsState = { status: "idle", n: 0 };
const IDLE_BOUNDARIES: BoundaryStatus = {
  loading: false,
  tooMany: false,
  dotsVisible: false,
  count: 0,
};

/** Colour for a category: the source's own, else the fallback palette. */
function colorForCategory(column: ColumnData, code: number): [number, number, number] {
  if (column.kind !== "categorical" || code < 0) return categoryColor(-1);
  return column.colors?.[code] ?? categoryColor(code);
}

/**
 * Builds the per-cell RGBA buffer for the current colouring. Runs over ~600k
 * cells, which is a few milliseconds — cheap enough to stay on the main thread
 * and avoid another round trip.
 *
 * Alpha carries visibility: cells in a hidden group, or with no value at all
 * for a categorical colouring, are made fully transparent rather than removed,
 * so the geometry buffers and picking indices stay untouched.
 */
function buildColors(
  coloring: CellColoring,
  column: ColumnData | undefined,
  n: number,
  uniform: [number, number, number],
  hidden?: ReadonlySet<string>,
): Uint8Array {
  const colors = new Uint8Array(n * 4);
  if (coloring.mode === "uniform" || !column) {
    for (let i = 0; i < n; i++) {
      colors[i * 4] = uniform[0];
      colors[i * 4 + 1] = uniform[1];
      colors[i * 4 + 2] = uniform[2];
      colors[i * 4 + 3] = 255;
    }
    return colors;
  }
  if (column.kind === "categorical") {
    // Resolve each category once, not once per cell.
    const lut = column.categories.map((label, code) => {
      const [r, g, b] = colorForCategory(column, code);
      return [r, g, b, hidden?.has(label) ? 0 : 255];
    });
    const missing = [110, 110, 110, coloring.mode === "group" ? 0 : 255];
    for (let i = 0; i < n; i++) {
      const entry = lut[column.codes[i]] ?? missing;
      colors[i * 4] = entry[0];
      colors[i * 4 + 1] = entry[1];
      colors[i * 4 + 2] = entry[2];
      colors[i * 4 + 3] = entry[3];
    }
    return colors;
  }
  const [lo, hi] = coloring.range ?? [column.min, column.max];
  const span = hi - lo || 1;
  // Precompute the ramp so the per-cell loop is a table lookup.
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = sampleColormap(coloring.colormap, i / 255);
    lut[i * 3] = r;
    lut[i * 3 + 1] = g;
    lut[i * 3 + 2] = b;
  }
  for (let i = 0; i < n; i++) {
    const t = (column.values[i] - lo) / span;
    const bin = (t <= 0 ? 0 : t >= 1 ? 255 : (t * 255) | 0) * 3;
    colors[i * 4] = lut[bin];
    colors[i * 4 + 1] = lut[bin + 1];
    colors[i * 4 + 2] = lut[bin + 2];
    colors[i * 4 + 3] = 255;
  }
  return colors;
}

/** Hidden category labels for whichever group set the colouring points at. */
function hiddenFor(state: AppState, coloring: CellColoring): Set<string> | undefined {
  if (coloring.mode !== "group") return undefined;
  const set = state.groupSets.find((g) => g.name === coloring.column);
  return set ? new Set(set.hidden) : undefined;
}

// Setters call persist() on every slider frame (dragging contrast, opacity),
// but IndexedDB writes are async and there is no reason to fire one per
// frame — so the actual write is debounced behind this delay.
const PERSIST_DEBOUNCE_MS = 400;
let persistTimer: ReturnType<typeof setTimeout> | undefined;

/** Saves the current display preferences into the open dataset's recent record. */
function persist(state: AppState): void {
  if (!state.recentId) return;
  const id = state.recentId;
  const settings: StoredSettings = {
    channels: state.channels.map((c) => ({
      visible: c.visible,
      color: c.color,
      contrastLimits: c.contrastLimits,
    })),
    showCells: state.showCells,
    showCellBoundaries: state.showCellBoundaries,
    showNucleusBoundaries: state.showNucleusBoundaries,
    boundaryStyle: state.boundaryStyle,
    cellOpacity: state.cellOpacity,
    imageOpacity: state.imageOpacity,
    cellColoring: state.cellColoring,
  };
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    void saveRecentSettings(id, settings);
  }, PERSIST_DEBOUNCE_MS);
}

export const useApp = create<AppState>((set, get) => ({
  status: "idle",
  channels: [],
  imageOpacity: 1,
  viewZoom: 0,
  cells: IDLE_CELLS,
  showCells: true,
  showCellBoundaries: true,
  showNucleusBoundaries: false,
  boundaryStyle: "outline",
  boundaryStatus: IDLE_BOUNDARIES,
  autoContrast: true,
  cellOpacity: 0.7,
  cellColoring: { mode: "uniform", colormap: "viridis" },
  uniformCellColor: [255, 255, 255],
  groupSets: [],
  groupImporting: false,

  async open(spec) {
    // React StrictMode double-invokes effects in development, and the auto-open
    // path runs from one — without this the whole dataset loads twice.
    if (get().status === "loading") return;
    get().cellsClient?.destroy();
    set({
      status: "loading",
      error: undefined,
      dataset: undefined,
      source: undefined,
      recentId: undefined,
      cells: IDLE_CELLS,
      cellsClient: undefined,
      selectedCell: undefined,
      cellDetails: undefined,
      groupSets: [],
      groupImportError: undefined,
    });
    try {
      const source = createDataSource(spec);
      const dataset = await loadDataset(source);
      const primary =
        dataset.images.find((i) => i.name === "morphology_focus") ?? dataset.images[0];
      const record = await touchRecent(spec);
      const saved = record.settings;
      const channels: ChannelSettings[] = primary.channels.map((_, i) => ({
        visible: saved.channels?.[i]?.visible ?? i < 4,
        color:
          saved.channels?.[i]?.color ?? DEFAULT_CHANNEL_COLORS[i % DEFAULT_CHANNEL_COLORS.length],
        contrastLimits: saved.channels?.[i]?.contrastLimits ?? [0, 1000],
        domain: [0, 65535],
        histogram: [],
      }));
      // Group sets come from files the user picks each session, so a saved
      // colouring that points at one has nothing to resolve against.
      // Also, ignore boundaryStyle and cellOpacity in this case.
      const restoreCellColoring = saved.cellColoring && saved.cellColoring.mode !== "group";
      set({
        status: "ready",
        source,
        dataset,
        recentId: record.id,
        channels,
        // Contrast is only auto-computed when the user has no saved window.
        autoContrast: !saved.channels,
        showCells: saved.showCells ?? true,
        showCellBoundaries: saved.showCellBoundaries ?? true,
        showNucleusBoundaries: saved.showNucleusBoundaries ?? false,
        boundaryStyle: restoreCellColoring ? (saved.boundaryStyle ?? "outline") : "outline",
        cellOpacity: restoreCellColoring ? (saved.cellOpacity ?? 0.7) : 0.7,
        imageOpacity: saved.imageOpacity ?? 1,
        cellColoring: restoreCellColoring
          ? saved.cellColoring
          : { mode: "uniform", colormap: "viridis" },
      });

      if (!dataset.table) return;
      const cellsClient = new CellsClient();
      set({ cellsClient, cells: { status: "loading", n: 0 } });
      try {
        const started = performance.now();
        const { n, positions } = await cellsClient.init(spec, dataset);
        console.info(
          `[cells] ${n.toLocaleString("en-US")} centroids in ` +
            `${Math.round(performance.now() - started)} ms`,
        );
        set({
          cells: {
            status: "ready",
            n,
            positions,
            colors: buildColors(get().cellColoring, undefined, n, get().uniformCellColor),
          },
        });
        // A restored colour column can only be fetched once the worker has the
        // table open, which is now.
        if (get().cellColoring.mode === "column") await get().setCellColoring({});
        // Cell ids are only needed for the hover tooltip, so fetch them in the
        // background rather than delaying the "ready" state.
        void cellsClient.ids().then((ids) => {
          const current = get().cells;
          if (current.status === "ready") set({ cells: { ...current, ids } });
        });
      } catch (err) {
        set({
          cells: {
            status: "error",
            n: 0,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    } catch (err) {
      set({ status: "error", error: err instanceof Error ? err.message : String(err) });
    }
  },

  setChannel(index, patch) {
    set((state) => ({
      channels: state.channels.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    }));
    persist(get());
  },

  setImageOpacity(value) {
    set({ imageOpacity: value });
    persist(get());
  },

  setViewZoom(zoom) {
    set({ viewZoom: zoom });
  },

  setShowCells(value) {
    set({ showCells: value });
    persist(get());
  },

  setShowCellBoundaries(value) {
    set({ showCellBoundaries: value });
    persist(get());
  },

  setShowNucleusBoundaries(value) {
    set({ showNucleusBoundaries: value });
    persist(get());
  },

  setBoundaryStyle(value) {
    set({ boundaryStyle: value });
    persist(get());
  },

  setBoundaryStatus(value) {
    const prev = get().boundaryStatus;
    if (
      prev.loading === value.loading &&
      prev.tooMany === value.tooMany &&
      prev.dotsVisible === value.dotsVisible &&
      prev.error === value.error &&
      prev.count === value.count
    ) {
      return;
    }
    set({ boundaryStatus: value });
  },

  setCellOpacity(value) {
    set({ cellOpacity: value });
    persist(get());
  },

  async setCellColoring(patch) {
    const state = get();
    const coloring = { ...state.cellColoring, ...patch };
    const { cellsClient, cells } = state;
    if (cells.status !== "ready") {
      set({ cellColoring: coloring });
      return;
    }

    let columnData = cells.columnData;
    if (coloring.mode !== "uniform" && coloring.column) {
      // Only refetch when the source actually changed; colormap, range and
      // visibility changes reuse the values already in memory.
      const changed =
        coloring.column !== state.cellColoring.column ||
        coloring.mode !== state.cellColoring.mode ||
        !columnData;
      if (changed) {
        columnData = await cellsClient?.column(coloring.column);
        if (columnData?.kind === "numeric" && !patch.range) {
          coloring.range = [columnData.p1, columnData.p99];
        }
      }
    } else {
      columnData = undefined;
    }

    set({
      cellColoring: coloring,
      cells: {
        ...get().cells,
        columnData,
        colors: buildColors(
          coloring,
          columnData,
          cells.n,
          state.uniformCellColor,
          hiddenFor(get(), coloring),
        ),
      },
    });
    persist(get());
  },

  async importGroupFiles(files) {
    const { cellsClient } = get();
    if (!cellsClient || files.length === 0) return;
    set({ groupImporting: true, groupImportError: undefined });
    try {
      let lastName: string | undefined;
      for (const file of files) {
        const name = file.name.replace(/\.(csv|tsv|txt)$/i, "");
        const summary = await cellsClient.importGroups(name, await file.text());
        console.info(
          `[groups] ${name}: ${summary.categories.length} groups, ` +
            `${summary.matched.toLocaleString("en-US")} cells matched` +
            (summary.unmatched ? `, ${summary.unmatched} unmatched` : "") +
            ` in ${summary.elapsedMs} ms`,
        );
        set((s) => ({
          // Re-importing the same name replaces the previous entry in place.
          groupSets: [...s.groupSets.filter((g) => g.name !== name), { ...summary, hidden: [] }],
        }));
        lastName = name;
      }
      set({ groupImporting: false });
      // Show what was just imported; that is the reason for importing it.
      if (lastName) await get().setCellColoring({ mode: "group", column: lastName });
    } catch (err) {
      set({
        groupImporting: false,
        groupImportError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  async removeGroupSet(name) {
    await get().cellsClient?.removeGroups(name);
    set((s) => ({ groupSets: s.groupSets.filter((g) => g.name !== name) }));
    const { cellColoring } = get();
    if (cellColoring.mode === "group" && cellColoring.column === name) {
      await get().setCellColoring({ mode: "uniform", column: undefined });
    }
  },

  toggleGroupCategory(name, category) {
    const current = get().groupSets.find((g) => g.name === name);
    if (!current) return;
    const hidden = current.hidden.includes(category)
      ? current.hidden.filter((c) => c !== category)
      : [...current.hidden, category];
    get().setGroupCategoriesHidden(name, hidden);
  },

  setGroupCategoriesHidden(name, hidden) {
    set((s) => ({
      groupSets: s.groupSets.map((g) => (g.name === name ? { ...g, hidden } : g)),
    }));
    const state = get();
    if (state.cellColoring.mode === "group" && state.cellColoring.column === name) {
      // Recolour in place; visibility lives in the alpha channel.
      const { cells } = state;
      if (cells.status === "ready") {
        set({
          cells: {
            ...cells,
            colors: buildColors(
              state.cellColoring,
              cells.columnData,
              cells.n,
              state.uniformCellColor,
              new Set(hidden),
            ),
          },
        });
      }
    }
  },

  async selectCell(index) {
    if (index === undefined) {
      set({ selectedCell: undefined, cellDetails: undefined });
      return;
    }
    set({ selectedCell: index, cellDetails: undefined });
    const details = await get().cellsClient?.details(index);
    // Ignore a slow response for a cell the user has already moved off.
    if (get().selectedCell === index) set({ cellDetails: details });
  },

  reset() {
    get().cellsClient?.destroy();
    set({
      status: "idle",
      error: undefined,
      dataset: undefined,
      source: undefined,
      recentId: undefined,
      channels: [],
      cells: IDLE_CELLS,
      cellsClient: undefined,
      selectedCell: undefined,
      cellDetails: undefined,
      groupSets: [],
      groupImportError: undefined,
    });
  },
}));

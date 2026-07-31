import { create } from "zustand";
import { CellsClient, type ColumnData } from "./data/cells";
import { type Dataset, loadDataset } from "./data/dataset";
import { loadSettings, saveSettings } from "./data/settings";
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

/** How the cells layer is coloured. `column` names an obs column. */
export interface CellColoring {
  mode: "uniform" | "column";
  column?: string;
  colormap: string;
  /** Value window for numeric columns; ignored for categorical ones. */
  range?: [number, number];
}

export interface CellsState {
  status: LoadStatus;
  error?: string;
  n: number;
  positions?: Float32Array;
  /** Per-cell RGB, derived from `coloring`. */
  colors?: Uint8Array;
  columnData?: ColumnData;
}

export interface AppState {
  status: LoadStatus;
  error?: string;
  source?: DataSource;
  dataset?: Dataset;
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
  selectedCell?: number;
  cellDetails?: Record<string, string>;
  /** Mirrored from the viewer so the panel can report boundary progress. */
  boundaryStatus: BoundaryStatus;
  /** False once contrast comes from saved settings rather than the data. */
  autoContrast: boolean;

  open(spec: SourceSpec): Promise<void>;
  setChannel(index: number, patch: Partial<ChannelSettings>): void;
  setImageOpacity(value: number): void;
  setViewZoom(zoom: number): void;
  setShowCells(value: boolean): void;
  setShowCellBoundaries(value: boolean): void;
  setShowNucleusBoundaries(value: boolean): void;
  setBoundaryStyle(value: "outline" | "fill" | "both"): void;
  setBoundaryStatus(value: BoundaryStatus): void;
  setCellOpacity(value: number): void;
  setCellColoring(patch: Partial<CellColoring>): Promise<void>;
  selectCell(index?: number): Promise<void>;
  reset(): void;
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

/**
 * Builds the per-cell RGB buffer for the current colouring. Runs over ~600k
 * cells, which is a few milliseconds — cheap enough to stay on the main thread
 * and avoid another round trip.
 */
function buildColors(
  coloring: CellColoring,
  column: ColumnData | undefined,
  n: number,
  uniform: [number, number, number],
): Uint8Array {
  const colors = new Uint8Array(n * 3);
  if (coloring.mode === "uniform" || !column) {
    for (let i = 0; i < n; i++) {
      colors[i * 3] = uniform[0];
      colors[i * 3 + 1] = uniform[1];
      colors[i * 3 + 2] = uniform[2];
    }
    return colors;
  }
  if (column.kind === "categorical") {
    for (let i = 0; i < n; i++) {
      const [r, g, b] = categoryColor(column.codes[i]);
      colors[i * 3] = r;
      colors[i * 3 + 1] = g;
      colors[i * 3 + 2] = b;
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
    colors[i * 3] = lut[bin];
    colors[i * 3 + 1] = lut[bin + 1];
    colors[i * 3 + 2] = lut[bin + 2];
  }
  return colors;
}

/** Persists the current display preferences for the open dataset. */
function persist(state: AppState): void {
  if (!state.dataset) return;
  saveSettings(state.dataset.name, {
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
  });
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
      cells: IDLE_CELLS,
      cellsClient: undefined,
      selectedCell: undefined,
      cellDetails: undefined,
    });
    try {
      const source = createDataSource(spec);
      const dataset = await loadDataset(source);
      const primary =
        dataset.images.find((i) => i.name === "morphology_focus") ?? dataset.images[0];
      const saved = loadSettings(dataset.name);
      const channels: ChannelSettings[] = primary.channels.map((_, i) => ({
        visible: saved.channels?.[i]?.visible ?? i < 4,
        color:
          saved.channels?.[i]?.color ??
          DEFAULT_CHANNEL_COLORS[i % DEFAULT_CHANNEL_COLORS.length],
        contrastLimits: saved.channels?.[i]?.contrastLimits ?? [0, 1000],
        domain: [0, 65535],
        histogram: [],
      }));
      set({
        status: "ready",
        source,
        dataset,
        channels,
        // Contrast is only auto-computed when the user has no saved window.
        autoContrast: !saved.channels,
        showCells: saved.showCells ?? true,
        showCellBoundaries: saved.showCellBoundaries ?? true,
        showNucleusBoundaries: saved.showNucleusBoundaries ?? false,
        boundaryStyle: saved.boundaryStyle ?? "outline",
        cellOpacity: saved.cellOpacity ?? 0.7,
        imageOpacity: saved.imageOpacity ?? 1,
        cellColoring: saved.cellColoring ?? { mode: "uniform", colormap: "viridis" },
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
    if (coloring.mode === "column" && coloring.column) {
      // Only refetch when the column actually changed; colormap and range
      // changes reuse the values already in memory.
      if (coloring.column !== state.cellColoring.column || !columnData) {
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
        colors: buildColors(coloring, columnData, cells.n, state.uniformCellColor),
      },
    });
    persist(get());
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
      channels: [],
      cells: IDLE_CELLS,
      cellsClient: undefined,
      selectedCell: undefined,
      cellDetails: undefined,
    });
  },
}));

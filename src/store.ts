import { create } from "zustand";
import { CellsClient, type ColumnData, type GeoJsonSummary } from "./data/cells";
import { type Dataset, loadDataset } from "./data/dataset";
import { ExpressionClient, type GeneCount } from "./data/expression";
import { saveRecentSettings, touchRecent, type StoredSettings } from "./data/recents";
import { type DataSource, type SourceSpec, createDataSource } from "./data/stores";
import { TranscriptsClient, type TranscriptsInit } from "./data/transcripts";
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
 * How the cells layer is coloured. `column` names an obs column, `group` an
 * imported cell-group set, and `gene` a row of `var`. They are separate modes
 * because the namespaces can collide — a file may well be called
 * `segmentation_method`, and a gene may share a name with an obs column.
 */
export interface CellColoring {
  mode: "uniform" | "column" | "group" | "gene";
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

/** The single user-imported alternative segmentation, if one has been loaded. */
export interface Segmentation extends GeoJsonSummary {
  name: string;
  /**
   * True when most of the imported geometry falls outside the slide — almost
   * always a units mismatch (the importer assumes micrometres, matching every
   * other coordinate a SpatialData store carries).
   */
  outOfBounds: boolean;
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

/** Progress of the one-off `X` read that backs colouring by gene. */
export interface MatrixStatus {
  status: LoadStatus;
  /** 0..1 while loading. */
  progress: number;
  error?: string;
}

export interface TranscriptStatus {
  loading: boolean;
  /** Viewport holds more points than we draw. */
  tooMany: boolean;
  /** Points drawn. */
  count: number;
  /** Points in the viewport, before the cap. */
  total: number;
  error?: string;
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
  /** Highest-expressed genes in the selected cell. */
  selectedCellGenes?: GeneCount[];
  /** Mirrored from the viewer so the panel can report boundary progress. */
  boundaryStatus: BoundaryStatus;
  /** False once contrast comes from saved settings rather than the data. */
  autoContrast: boolean;

  /** The imported alternative segmentation; a second import replaces it. */
  segmentation?: Segmentation;
  segmentationImporting: boolean;
  /** 0..1 while importing. */
  segmentationProgress: number;
  segmentationError?: string;
  showSegmentation: boolean;
  segmentationColor: [number, number, number];
  segmentationStyle: "outline" | "fill" | "both";
  segmentationOpacity: number;
  /** Mirrored from the viewer, like `boundaryStatus`. */
  segmentationStatus: BoundaryStatus;

  expressionClient?: ExpressionClient;
  /** Gene names from `var`, in column order. Empty when there is no `X`. */
  genes: string[];
  matrixStatus: MatrixStatus;

  transcriptsClient?: TranscriptsClient;
  transcriptInfo?: TranscriptsInit;
  showTranscripts: boolean;
  transcriptPointSize: number;
  transcriptOpacity: number;
  /** Genes given their own colour; everything else is drawn neutral or hidden. */
  transcriptGenes: string[];
  hideOtherTranscripts: boolean;
  transcriptStatus: TranscriptStatus;

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
  importSegmentation: (file: File) => Promise<void>;
  removeSegmentation: () => Promise<void>;
  setShowSegmentation: (value: boolean) => void;
  setSegmentationColor: (value: [number, number, number]) => void;
  setSegmentationStyle: (value: "outline" | "fill" | "both") => void;
  setSegmentationOpacity: (value: number) => void;
  setSegmentationStatus: (value: BoundaryStatus) => void;
  selectCell: (index?: number) => Promise<void>;
  loadExpressionMatrix: () => Promise<void>;
  initTranscripts: () => Promise<void>;
  setShowTranscripts: (value: boolean) => void;
  setTranscriptPointSize: (value: number) => void;
  setTranscriptOpacity: (value: number) => void;
  toggleTranscriptGene: (gene: string) => void;
  setHideOtherTranscripts: (value: boolean) => void;
  setTranscriptStatus: (value: TranscriptStatus) => void;
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
const IDLE_MATRIX: MatrixStatus = { status: "idle", progress: 0 };
const IDLE_TRANSCRIPTS: TranscriptStatus = {
  loading: false,
  tooMany: false,
  count: 0,
  total: 0,
};

/** Genes listed for the selected cell in the inspector. */
const TOP_GENES = 10;

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

// Both of these are one-off loads shared by every caller that needs them, and
// both outlive a single action, so the in-flight promise lives beside the
// store rather than in it. Cleared whenever a dataset is opened or closed.
let matrixPending: Promise<void> | undefined;
let transcriptsPending: Promise<void> | undefined;
// The transcripts worker codes its points against the gene list, so it must not
// start before the names are read — otherwise every feature codes as unknown
// and the mapping is baked into the decoded row groups it caches.
let genesPending: Promise<void> | undefined;

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
    showTranscripts: state.showTranscripts,
    transcriptPointSize: state.transcriptPointSize,
    transcriptOpacity: state.transcriptOpacity,
    transcriptGenes: state.transcriptGenes,
    hideOtherTranscripts: state.hideOtherTranscripts,
    showSegmentation: state.showSegmentation,
    segmentationColor: state.segmentationColor,
    segmentationStyle: state.segmentationStyle,
    segmentationOpacity: state.segmentationOpacity,
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
  segmentationImporting: false,
  segmentationProgress: 0,
  showSegmentation: true,
  // Amber — visually distinct from the grey/blue Xenium boundary colours.
  segmentationColor: [255, 176, 46],
  segmentationStyle: "outline",
  segmentationOpacity: 0.9,
  segmentationStatus: IDLE_BOUNDARIES,
  genes: [],
  matrixStatus: IDLE_MATRIX,
  showTranscripts: false,
  // A dense field holds a few transcripts per screen pixel at cellular zoom, so
  // anything larger than a 1 px radius at full opacity paints over the image
  // entirely instead of showing where the signal is.
  transcriptPointSize: 1,
  transcriptOpacity: 0.55,
  transcriptGenes: [],
  hideOtherTranscripts: false,
  transcriptStatus: IDLE_TRANSCRIPTS,

  async open(spec) {
    // React StrictMode double-invokes effects in development, and the auto-open
    // path runs from one — without this the whole dataset loads twice.
    if (get().status === "loading") return;
    get().cellsClient?.destroy();
    get().expressionClient?.destroy();
    get().transcriptsClient?.destroy();
    matrixPending = undefined;
    transcriptsPending = undefined;
    genesPending = undefined;
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
      selectedCellGenes: undefined,
      groupSets: [],
      groupImportError: undefined,
      expressionClient: undefined,
      genes: [],
      matrixStatus: IDLE_MATRIX,
      transcriptsClient: undefined,
      transcriptInfo: undefined,
      transcriptStatus: IDLE_TRANSCRIPTS,
      // The imported segmentation is a session artefact, like group sets —
      // there is no file to reload it from.
      segmentation: undefined,
      segmentationImporting: false,
      segmentationProgress: 0,
      segmentationError: undefined,
      segmentationStatus: IDLE_BOUNDARIES,
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
      // A saved gene needs an `X` to resolve against for the same reason —
      // without one the Genes panel is hidden and the choice is unclearable.
      const restoreCellColoring =
        saved.cellColoring &&
        saved.cellColoring.mode !== "group" &&
        (saved.cellColoring.mode !== "gene" || dataset.table?.x !== undefined);
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
        showTranscripts: saved.showTranscripts ?? false,
        transcriptPointSize: saved.transcriptPointSize ?? 1,
        transcriptOpacity: saved.transcriptOpacity ?? 0.55,
        transcriptGenes: saved.transcriptGenes ?? [],
        hideOtherTranscripts: saved.hideOtherTranscripts ?? false,
        showSegmentation: saved.showSegmentation ?? true,
        segmentationColor: saved.segmentationColor ?? [255, 176, 46],
        segmentationStyle: saved.segmentationStyle ?? "outline",
        segmentationOpacity: saved.segmentationOpacity ?? 0.9,
      });

      // Transcripts do not need a table; the gene list only labels their
      // features, and an unlabelled point still draws.
      if (dataset.points.length > 0) set({ transcriptsClient: new TranscriptsClient() });

      if (!dataset.table) return;

      // Only the gene names are read here — `X` itself is left alone until
      // something actually asks for a gene. Started before the centroids
      // because the transcripts worker cannot begin without the names, and the
      // two reads are independent.
      if (dataset.table.x) {
        const expressionClient = new ExpressionClient();
        set({ expressionClient });
        genesPending = expressionClient.init(spec, dataset).then(
          ({ genes }) => set({ genes }),
          (err: unknown) => {
            // A malformed `X` should cost the gene features, not the dataset.
            console.warn("[expression] unavailable:", err);
            expressionClient.destroy();
            set({ expressionClient: undefined });
          },
        );
      }

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

        // A restored colour column or gene can only be fetched once the worker
        // has the table open, which is now.
        await genesPending;
        const restoredMode = get().cellColoring.mode;
        if (restoredMode === "column" || restoredMode === "gene") {
          await get().setCellColoring({});
        }
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
        if (coloring.mode === "gene") {
          // The first gene picked pays for reading X; every one after is a
          // per-row binary search in the worker.
          await get().loadExpressionMatrix();
          columnData =
            get().matrixStatus.status === "ready"
              ? await get().expressionClient?.geneValues(coloring.column)
              : undefined;
        } else {
          columnData = await cellsClient?.column(coloring.column);
        }
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

  async importSegmentation(file) {
    const { cellsClient, dataset } = get();
    if (!cellsClient || !dataset) return;
    set({ segmentationImporting: true, segmentationProgress: 0, segmentationError: undefined });
    try {
      const summary = await cellsClient.importGeoJson(dataset, file, (fraction) => {
        set({ segmentationProgress: fraction });
      });
      console.info(
        `[segmentation] ${summary.count.toLocaleString("en-US")} polygons, ` +
          `${summary.vertices.toLocaleString("en-US")} vertices` +
          (summary.skipped ? `, ${summary.skipped} skipped` : "") +
          (summary.droppedRings ? `, ${summary.droppedRings} rings dropped` : "") +
          ` in ${summary.elapsedMs} ms`,
      );
      // A file authored in pixels rather than micrometres lands scaled down by
      // the pixel size (~4.7x on this dataset) into one corner of the slide —
      // this is the cheapest signal that catches that without decoding twice.
      const [minX, minY, maxX, maxY] = summary.bounds;
      const overlapX = Math.max(0, Math.min(maxX, dataset.width) - Math.max(minX, 0));
      const overlapY = Math.max(0, Math.min(maxY, dataset.height) - Math.max(minY, 0));
      const area = Math.max(1, (maxX - minX) * (maxY - minY));
      const outOfBounds = (overlapX * overlapY) / area < 0.5;
      const name = file.name.replace(/\.(geo)?json$/i, "");
      set({
        segmentation: { ...summary, name, outOfBounds },
        segmentationImporting: false,
        segmentationProgress: 1,
      });
    } catch (err) {
      set({
        segmentationImporting: false,
        segmentationProgress: 0,
        segmentationError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  async removeSegmentation() {
    await get().cellsClient?.removeGeoJson();
    set({ segmentation: undefined, segmentationProgress: 0, segmentationStatus: IDLE_BOUNDARIES });
  },

  setShowSegmentation(value) {
    set({ showSegmentation: value });
    persist(get());
  },

  setSegmentationColor(value) {
    set({ segmentationColor: value });
    persist(get());
  },

  setSegmentationStyle(value) {
    set({ segmentationStyle: value });
    persist(get());
  },

  setSegmentationOpacity(value) {
    set({ segmentationOpacity: value });
    persist(get());
  },

  setSegmentationStatus(value) {
    const prev = get().segmentationStatus;
    if (
      prev.loading === value.loading &&
      prev.tooMany === value.tooMany &&
      prev.dotsVisible === value.dotsVisible &&
      prev.error === value.error &&
      prev.count === value.count
    ) {
      return;
    }
    set({ segmentationStatus: value });
  },

  async selectCell(index) {
    if (index === undefined) {
      set({ selectedCell: undefined, cellDetails: undefined, selectedCellGenes: undefined });
      return;
    }
    set({ selectedCell: index, cellDetails: undefined, selectedCellGenes: undefined });
    const { cellsClient, expressionClient } = get();
    const [details, genes] = await Promise.all([
      cellsClient?.details(index),
      // A CSR row is contiguous, so this does not wait on the full matrix. It
      // must not take the details down with it if X is unreadable.
      expressionClient?.cellGenes(index, TOP_GENES).catch(() => undefined),
    ]);
    // Ignore a slow response for a cell the user has already moved off.
    if (get().selectedCell === index) set({ cellDetails: details, selectedCellGenes: genes });
  },

  loadExpressionMatrix() {
    const client = get().expressionClient;
    if (!client) return Promise.resolve();
    matrixPending ??= (async () => {
      set({ matrixStatus: { status: "loading", progress: 0 } });
      try {
        const summary = await client.loadMatrix((progress) => {
          set({ matrixStatus: { status: "loading", progress } });
        });
        console.info(
          `[expression] ${summary.nnz.toLocaleString("en-US")} non-zeros, ` +
            `${Math.round(summary.bytes / 1048576)} MB resident, ` +
            `${summary.compact ? "byte counts" : "float values"}` +
            `${summary.sorted ? "" : ", unsorted rows (linear lookup)"} ` +
            `in ${summary.elapsedMs} ms`,
        );
        set({ matrixStatus: { status: "ready", progress: 1 } });
      } catch (err) {
        // Let a later attempt retry rather than latching the failure.
        matrixPending = undefined;
        set({
          matrixStatus: {
            status: "error",
            progress: 0,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    })();
    return matrixPending;
  },

  initTranscripts() {
    const { transcriptsClient, dataset, source } = get();
    const element = dataset?.points[0];
    if (!transcriptsClient || !element || !source) return Promise.resolve();
    transcriptsPending ??= (async () => {
      try {
        // The gene list codes the points, and that coding is baked into the
        // row groups the worker caches, so it has to be right the first time.
        await genesPending;
        const info = await transcriptsClient.init(source.spec, element, get().genes);
        console.info(
          `[transcripts] ${info.totalRows.toLocaleString("en-US")} points across ` +
            `${info.parts} parts / ${info.rowGroups} row groups in ${info.elapsedMs} ms`,
        );
        set({ transcriptInfo: info });
      } catch (err) {
        transcriptsPending = undefined;
        set((s) => ({
          transcriptStatus: {
            ...s.transcriptStatus,
            loading: false,
            error: err instanceof Error ? err.message : String(err),
          },
        }));
      }
    })();
    return transcriptsPending;
  },

  setShowTranscripts(value) {
    set({ showTranscripts: value });
    persist(get());
  },

  setTranscriptPointSize(value) {
    set({ transcriptPointSize: value });
    persist(get());
  },

  setTranscriptOpacity(value) {
    set({ transcriptOpacity: value });
    persist(get());
  },

  toggleTranscriptGene(gene) {
    set((s) => ({
      transcriptGenes: s.transcriptGenes.includes(gene)
        ? s.transcriptGenes.filter((g) => g !== gene)
        : [...s.transcriptGenes, gene],
    }));
    persist(get());
  },

  setHideOtherTranscripts(value) {
    set({ hideOtherTranscripts: value });
    persist(get());
  },

  setTranscriptStatus(value) {
    // Same reasoning as setBoundaryStatus: this fires on every viewport tick.
    const prev = get().transcriptStatus;
    if (
      prev.loading === value.loading &&
      prev.tooMany === value.tooMany &&
      prev.count === value.count &&
      prev.total === value.total &&
      prev.error === value.error
    ) {
      return;
    }
    set({ transcriptStatus: value });
  },

  reset() {
    get().cellsClient?.destroy();
    get().expressionClient?.destroy();
    get().transcriptsClient?.destroy();
    matrixPending = undefined;
    transcriptsPending = undefined;
    genesPending = undefined;
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
      selectedCellGenes: undefined,
      groupSets: [],
      groupImportError: undefined,
      expressionClient: undefined,
      genes: [],
      matrixStatus: IDLE_MATRIX,
      transcriptsClient: undefined,
      transcriptInfo: undefined,
      transcriptStatus: IDLE_TRANSCRIPTS,
      segmentation: undefined,
      segmentationImporting: false,
      segmentationProgress: 0,
      segmentationError: undefined,
      segmentationStatus: IDLE_BOUNDARIES,
    });
  },
}));

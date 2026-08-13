import { type Layer, OrthographicView, type OrthographicViewState } from "@deck.gl/core";
import { ScatterplotLayer } from "@deck.gl/layers";
import DeckGL from "@deck.gl/react";
import { ColorPaletteExtension, MultiscaleImageLayer } from "@hms-dbmi/viv";
import { useEffect, useRef, useState } from "react";
import { IMPORTED_SEGMENTATION_KEY } from "../data/cells";
import { useApp } from "../store";
import { Minimap } from "../ui/Minimap";
import { ScaleBar } from "../ui/ScaleBar";
import { ImagePyramid } from "./ZarrPixelSource";
import { buildBoundaryLayers } from "./boundaryLayers";
import {
  buildTranscriptLayers,
  buildTranscriptLut,
  expandTranscriptColors,
} from "./transcriptLayers";
import { useBoundaries } from "./useBoundaries";
import { useTranscripts } from "./useTranscripts";

const VIEW = new OrthographicView({ id: "ortho", controller: { inertia: 250 } });

/** Tiles kept in deck.gl's cache; see the note where it is applied. */
const TILE_CACHE_SIZE = 40;

/** Centroid dot radius, in level-0 image pixels (~1.5 µm at 0.2125 µm/px). */
const CELL_RADIUS_PX = 7;

const TOOLTIP_STYLE = {
  background: "#161a20",
  border: "1px solid #2b323c",
  borderRadius: "5px",
  color: "#dfe4ea",
  fontSize: "12px",
  padding: "6px 9px",
  whiteSpace: "pre",
} as const;

function formatValue(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (Number.isInteger(value)) return value.toLocaleString("en-US");
  return value.toFixed(2);
}

/** Zoom that fits `width` x `height` world units into a `w` x `h` viewport. */
function fitZoom(width: number, height: number, w: number, h: number): number {
  return Math.log2(Math.min(w / width, h / height));
}

/**
 * Viv reads `excludeBackground` and `maxCacheSize` at runtime but declares
 * neither on its layer props, so they can only be passed through an untyped
 * cast. Isolated here, with an explicit return type, so the `any` cannot leak
 * into the layer array.
 */
function createImageLayer(props: Record<string, unknown>): Layer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
  return new MultiscaleImageLayer(props as any) as Layer;
}

export function Viewer() {
  const source = useApp((s) => s.source);
  const dataset = useApp((s) => s.dataset);
  const channels = useApp((s) => s.channels);
  const imageOpacity = useApp((s) => s.imageOpacity);
  const setChannel = useApp((s) => s.setChannel);
  const setViewZoom = useApp((s) => s.setViewZoom);
  const autoContrast = useApp((s) => s.autoContrast);
  const cells = useApp((s) => s.cells);
  const showCells = useApp((s) => s.showCells);
  const showCellBoundaries = useApp((s) => s.showCellBoundaries);
  const showNucleusBoundaries = useApp((s) => s.showNucleusBoundaries);
  const boundaryStyle = useApp((s) => s.boundaryStyle);
  const cellOpacity = useApp((s) => s.cellOpacity);
  const cellColoring = useApp((s) => s.cellColoring);
  const selectedCell = useApp((s) => s.selectedCell);
  const selectCell = useApp((s) => s.selectCell);
  const genes = useApp((s) => s.genes);
  const showTranscripts = useApp((s) => s.showTranscripts);
  const transcriptPointSize = useApp((s) => s.transcriptPointSize);
  const transcriptOpacity = useApp((s) => s.transcriptOpacity);
  const transcriptGenes = useApp((s) => s.transcriptGenes);
  const hideOtherTranscripts = useApp((s) => s.hideOtherTranscripts);
  const segmentation = useApp((s) => s.segmentation);
  const showSegmentation = useApp((s) => s.showSegmentation);
  const segmentationColor = useApp((s) => s.segmentationColor);
  const segmentationStyle = useApp((s) => s.segmentationStyle);
  const segmentationOpacity = useApp((s) => s.segmentationOpacity);

  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [viewState, setViewState] = useState<OrthographicViewState>();

  const primary = dataset?.images.find((i) => i.name === "morphology_focus") ?? dataset?.images[0];

  // Created inside the effect rather than in a memo so that construction and
  // `destroy()` are always paired: a memo survives StrictMode's remount, so its
  // workers would be terminated by the first cleanup and never replaced.
  //
  // A worker pool is exactly the "external system" an effect is for, and its
  // handle has to reach render somehow — so setState here is the intended
  // shape, not the cascading-render pattern the rule targets.
  const [pyramid, setPyramid] = useState<ImagePyramid>();
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!source || !primary) {
      setPyramid(undefined);
      return;
    }
    const instance = new ImagePyramid(source.spec, primary);
    setPyramid(instance);
    return () => {
      instance.destroy();
      setPyramid(undefined);
    };
  }, [source, primary]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Track the container size so the initial fit is correct.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width, height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const fit = () => {
    if (!primary || size.width === 0) return;
    setViewState({
      target: [primary.width / 2, primary.height / 2, 0],
      zoom: fitZoom(primary.width, primary.height, size.width, size.height),
    });
  };

  // Fit once, as soon as we know both the image and the viewport size — unless
  // the URL pins a view (`?x=&y=&zoom=` in level-0 pixels), which makes a
  // particular field of view linkable and keeps tests deterministic.
  //
  // The initial view depends on a measurement that only exists after layout, so
  // it cannot be a lazy initial state; it runs exactly once, guarded by a ref.
  const fitted = useRef(false);
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (fitted.current || !primary || size.width === 0) return;
    fitted.current = true;
    const params = new URLSearchParams(window.location.search);
    const x = Number(params.get("x"));
    const y = Number(params.get("y"));
    const zoom = Number(params.get("zoom"));
    if (params.has("x") && params.has("y") && params.has("zoom")) {
      setViewState({ target: [x, y, 0], zoom });
    } else {
      fit();
    }
  }, [fit, primary, size.width]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    fitted.current = false;
  }, [primary]);

  // Auto-contrast from the smallest pyramid level, once per dataset.
  useEffect(() => {
    if (!pyramid) return;
    let cancelled = false;
    const started = performance.now();
    void (async () => {
      for (let c = 0; c < pyramid.image.channels.length; c++) {
        const stats = await pyramid.channelStats(c);
        if (cancelled) return;
        if (c === pyramid.image.channels.length - 1) {
          console.info(`[image] channel stats in ${Math.round(performance.now() - started)} ms`);
        }
        setChannel(c, {
          // A window restored from saved settings wins over the computed one.
          ...(autoContrast ? { contrastLimits: stats.contrastLimits } : {}),
          domain: [stats.min, stats.max],
          histogram: stats.histogram,
          thumbnail: stats.thumbnail,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pyramid, setChannel, autoContrast]);

  useEffect(() => {
    if (typeof viewState?.zoom === "number") setViewZoom(viewState.zoom);
  }, [viewState?.zoom, setViewZoom]);

  // Viv refetches every raster and drops its tile cache whenever the identity of
  // `selections` changes, so this must not be rebuilt when contrast or colour
  // changes — only when the channel count does.
  const selections = Array.from({ length: channels.length }, (_, c) => ({ c }));

  /** World-space bounds of what the viewport currently shows. */
  const viewBounds = (() => {
    if (!viewState || typeof viewState.zoom !== "number" || size.width === 0) return undefined;
    const scale = 2 ** viewState.zoom;
    const halfW = size.width / 2 / scale;
    const halfH = size.height / 2 / scale;
    const [cx, cy] = viewState.target as number[];
    return [cx - halfW, cy - halfH, cx + halfW, cy + halfH] as const;
  })();

  const panTo = (x: number, y: number) => {
    setViewState((prev) => (prev ? { ...prev, target: [x, y, 0] } : prev));
  };

  const cellBoundaries = useBoundaries(
    "cell_boundaries",
    showCells && showCellBoundaries,
    viewBounds,
  );
  const nucleusBoundaries = useBoundaries(
    "nucleus_boundaries",
    showCells && showNucleusBoundaries,
    viewBounds,
  );
  // Gated on its own toggle rather than `showCells`, so the alternative
  // segmentation can be judged against the image with the Xenium boundaries
  // off. `segmentation` (the import summary) doubles as the `preloaded`
  // identity: its geometry was already decoded by the import action, and a
  // new value after re-importing forces a fresh viewport query.
  const altBoundaries = useBoundaries(
    IMPORTED_SEGMENTATION_KEY,
    showSegmentation && !!segmentation,
    viewBounds,
    segmentation,
  );

  const transcripts = useTranscripts(showTranscripts, viewBounds);

  // Colours are resolved here rather than in the worker so that changing the
  // highlighted genes recolours what is already on screen instead of
  // re-running the viewport query.
  const transcriptLayers = (() => {
    if (!transcripts.points) return [];
    const highlighted = transcriptGenes.map((name) => genes.indexOf(name));
    const lut = buildTranscriptLut(genes.length, highlighted, hideOtherTranscripts);
    const colors = expandTranscriptColors(transcripts.points.codes, lut, genes.length);
    return buildTranscriptLayers({
      points: transcripts.points,
      colors,
      pointSize: transcriptPointSize,
      opacity: transcriptOpacity,
    });
  })();

  const setTranscriptStatus = useApp((s) => s.setTranscriptStatus);
  useEffect(() => {
    setTranscriptStatus({
      loading: transcripts.loading,
      tooMany: transcripts.tooMany,
      count: transcripts.count,
      total: transcripts.total,
      error: transcripts.error,
    });
  }, [setTranscriptStatus, transcripts]);

  const boundaryLayers = (() => {
    if (!showCells) return [];
    const layers = [];
    if (cellBoundaries.shapes) {
      layers.push(
        ...buildBoundaryLayers({
          id: "cell-boundaries",
          shapes: cellBoundaries.shapes,
          cellColors: cells.colors,
          fallbackColor: [200, 200, 200],
          style: boundaryStyle,
          opacity: cellOpacity,
          onClick: (index) => void selectCell(index >= 0 ? index : undefined),
        }),
      );
    }
    if (nucleusBoundaries.shapes) {
      layers.push(
        ...buildBoundaryLayers({
          id: "nucleus-boundaries",
          shapes: nucleusBoundaries.shapes,
          fallbackColor: [120, 170, 255],
          style: "outline",
          opacity: cellOpacity,
          // Nuclei sit inside cells, so letting them pick would shadow the
          // cell layer for the same click.
          pickable: false,
        }),
      );
    }
    return layers;
  })();

  // Independent of `showCells` — the point of an alternative segmentation is
  // to judge it against the morphology image, with or without the Xenium
  // boundaries showing. Drawn last (see `layers` below) so it sits on top of
  // them. Not pickable — like nuclei, an overlapping set that answered clicks
  // would shadow the cell layer underneath it.
  const altBoundaryLayers = altBoundaries.shapes
    ? buildBoundaryLayers({
        id: "alt-segmentation",
        shapes: altBoundaries.shapes,
        fallbackColor: segmentationColor,
        style: segmentationStyle,
        opacity: segmentationOpacity,
        pickable: false,
      })
    : [];

  // Dots stand in whenever polygons are not being drawn — either because
  // boundaries are off, still loading, or there are too many in view.
  const showDots =
    showCells &&
    boundaryLayers.length === 0 &&
    (!showCellBoundaries || cellBoundaries.tooMany || cellBoundaries.loading);

  /**
   * Opacity multiplier for centroid dots, from how much of a screen pixel one
   * cell covers.
   *
   * Below about half a pixel, 600k dots stop resolving and merge into a veil.
   * When they carry data — an obs column or a cell-group assignment — that veil
   * is still the point of the view, so it keeps a floor of alpha; when they are
   * a uniform colour it says nothing the image does not already show, and is
   * dropped instead of dulling it.
   */
  const dotCoverage = (() => {
    const zoom = typeof viewState?.zoom === "number" ? viewState.zoom : 0;
    const screenRadius = CELL_RADIUS_PX * 2 ** zoom;
    if (cellColoring.mode !== "uniform") return Math.min(1, Math.max(0.22, screenRadius));
    return screenRadius < 0.5 ? 0 : Math.min(1, screenRadius);
  })();

  const dotsVisible = showDots && dotCoverage > 0 && cells.status === "ready";
  const setBoundaryStatus = useApp((s) => s.setBoundaryStatus);
  useEffect(() => {
    setBoundaryStatus({
      loading: cellBoundaries.loading || nucleusBoundaries.loading,
      tooMany: cellBoundaries.tooMany || nucleusBoundaries.tooMany,
      dotsVisible,
      error: cellBoundaries.error ?? nucleusBoundaries.error,
      count: cellBoundaries.shapes?.count ?? 0,
    });
  }, [setBoundaryStatus, cellBoundaries, nucleusBoundaries, dotsVisible]);

  const setSegmentationStatus = useApp((s) => s.setSegmentationStatus);
  useEffect(() => {
    setSegmentationStatus({
      loading: altBoundaries.loading,
      tooMany: altBoundaries.tooMany,
      dotsVisible: false,
      error: altBoundaries.error,
      count: altBoundaries.shapes?.count ?? 0,
    });
  }, [setSegmentationStatus, altBoundaries]);

  const cellLayers = (() => {
    if (!showDots || dotCoverage === 0) return [];
    if (cells.status !== "ready" || !cells.positions || !cells.colors) return [];
    return [
      new ScatterplotLayer({
        id: "cell-centroids",
        data: {
          length: cells.n,
          attributes: {
            getPosition: { value: cells.positions, size: 2 },
            getFillColor: { value: cells.colors, size: 4 },
          },
        },
        // Radius in world units so dots track the tissue as you zoom, with a
        // floor that keeps them visible at whole-slide scale.
        radiusUnits: "common",
        getRadius: CELL_RADIUS_PX,
        radiusMinPixels: 0.6,
        radiusMaxPixels: 7,
        // Once a cell is smaller than a screen pixel, hundreds of thousands of
        // dots merge into one opaque sheet that hides the image underneath.
        // Fading them in proportion to their coverage turns that sheet back
        // into a density wash while staying fully solid at cellular zoom.
        opacity: cellOpacity * dotCoverage,
        pickable: true,
        onClick: (info) => {
          void selectCell(info.index >= 0 ? info.index : undefined);
          return true;
        },
        updateTriggers: { getFillColor: cells.colors },
      }),
    ];
  })();

  const selectionLayer = (() => {
    if (selectedCell === undefined || !cells.positions) return [];
    return [
      new ScatterplotLayer({
        id: "cell-selected",
        data: [selectedCell],
        getPosition: (i: number) => [cells.positions![i * 2], cells.positions![i * 2 + 1]],
        radiusUnits: "common",
        getRadius: CELL_RADIUS_PX * 2,
        radiusMinPixels: 6,
        filled: false,
        stroked: true,
        getLineColor: [255, 235, 0],
        lineWidthUnits: "pixels",
        getLineWidth: 2,
        pickable: false,
      }),
    ];
  })();

  const layers = (() => {
    if (!pyramid || channels.length === 0) return [];
    return [
      createImageLayer({
        id: "morphology",
        loader: pyramid.levels,
        selections,
        contrastLimits: channels.map((ch) => ch.contrastLimits),
        colors: channels.map((ch) => ch.color),
        channelsVisible: channels.map((ch) => ch.visible),
        opacity: imageOpacity,
        extensions: [new ColorPaletteExtension()],
        // Viv's backdrop layer holds the whole lowest pyramid level in memory
        // (~42 MB per channel) purely to avoid gaps while tiles load. The
        // minimap covers the "where am I" need, and deck.gl's tile refinement
        // covers the gaps, so it isn't worth the memory here.
        excludeBackground: true,
        // deck.gl's default cache is 5x the visible tile count. A tile here is
        // 1024x1024x uint16 per channel (8 MB for four channels), so the default
        // runs to gigabytes on a whole-slide view. Cap it instead.
        maxCacheSize: TILE_CACHE_SIZE,
      }),
      // Transcripts sit under the cell layers: boundaries and centroids are the
      // things you click, and a dense point cloud would otherwise bury them.
      ...transcriptLayers,
      ...boundaryLayers,
      ...cellLayers,
      ...selectionLayer,
      ...altBoundaryLayers,
    ];
  })();

  /**
   * Hover readout. Boundary layers index by polygon, so they carry their own
   * polygon-to-cell mapping; the centroid layer indexes by cell directly.
   */
  const getTooltip = (info: { index: number; layer?: { id: string } | null }) => {
    if (!info.layer || info.index < 0) return null;
    const id = info.layer.id;
    let cell = info.index;
    if (id.startsWith("cell-boundaries")) {
      cell = cellBoundaries.shapes?.cellIndices[info.index] ?? -1;
    } else if (id.startsWith("nucleus-boundaries")) {
      cell = nucleusBoundaries.shapes?.cellIndices[info.index] ?? -1;
    } else if (id !== "cell-centroids") {
      return null;
    }
    if (cell < 0) return null;

    const cellId = cells.ids?.[cell];
    const lines = [cellId ? `Cell ${cellId}` : `Cell #${cell.toLocaleString("en-US")}`];
    const column = cells.columnData;
    if (column && cellColoring.column) {
      const value =
        column.kind === "numeric"
          ? formatValue(column.values[cell])
          : (column.categories[column.codes[cell]] ?? "—");
      lines.push(`${cellColoring.column}: ${value}`);
    }
    return { text: lines.join("\n"), style: TOOLTIP_STYLE };
  };

  return (
    <div ref={containerRef} className="stage-inner">
      {viewState && (
        <DeckGL
          // Exposed for debugging from the console: layer list, tile cache
          // occupancy, viewport state. Dev builds only.
          ref={(r) => {
            if (import.meta.env.DEV) {
              /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
              (window as any).__deck = (r as any)?.deck;
              /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
            }
          }}
          views={VIEW}
          viewState={viewState}
          onViewStateChange={({ viewState: next }) => setViewState(next)}
          layers={layers}
          getTooltip={getTooltip}
          getCursor={({ isHovering }) => (isHovering ? "pointer" : "grab")}
          useDevicePixels={false}
        />
      )}
      <div className="stage-overlay">
        <button onClick={fit}>Fit</button>
      </div>
      <ScaleBar />
      {primary && (
        <Minimap
          bounds={viewBounds}
          imageWidth={primary.width}
          imageHeight={primary.height}
          onNavigate={panTo}
        />
      )}
    </div>
  );
}

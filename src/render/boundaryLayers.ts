import type { Layer } from "@deck.gl/core";
import { PathLayer, SolidPolygonLayer } from "@deck.gl/layers";
import type { ViewportShapes } from "../data/cells";

type Shapes = Extract<ViewportShapes, { tooMany: false }>;

export interface BoundaryLayerOptions {
  id: string;
  shapes: Shapes;
  /** Per-cell RGB for the whole table; indexed via `shapes.cellIndices`. */
  cellColors?: Uint8Array;
  /** Used for polygons with no matching table row. */
  fallbackColor: [number, number, number];
  style: "outline" | "fill" | "both";
  opacity: number;
  /** Whether this set answers hover/click. Only one set should. */
  pickable?: boolean;
  onClick?: (cellIndex: number) => void;
}

/**
 * deck.gl wants colours per *vertex* when data is supplied in binary form, so
 * the per-cell RGBA is expanded across each polygon's vertices. Alpha comes
 * along for the ride, which is how hidden groups disappear.
 */
function expandColors(
  shapes: Shapes,
  cellColors: Uint8Array | undefined,
  fallback: [number, number, number],
): Uint8Array {
  const vertices = shapes.startIndices[shapes.count];
  const out = new Uint8Array(vertices * 4);
  for (let p = 0; p < shapes.count; p++) {
    const cell = shapes.cellIndices[p];
    const hasColor = cellColors && cell >= 0;
    const r = hasColor ? cellColors[cell * 4] : fallback[0];
    const g = hasColor ? cellColors[cell * 4 + 1] : fallback[1];
    const b = hasColor ? cellColors[cell * 4 + 2] : fallback[2];
    const a = hasColor ? cellColors[cell * 4 + 3] : 255;
    for (let v = shapes.startIndices[p]; v < shapes.startIndices[p + 1]; v++) {
      out[v * 4] = r;
      out[v * 4 + 1] = g;
      out[v * 4 + 2] = b;
      out[v * 4 + 3] = a;
    }
  }
  return out;
}

export function buildBoundaryLayers(options: BoundaryLayerOptions): Layer[] {
  const { id, shapes, style, opacity, onClick } = options;
  if (shapes.count === 0) return [];
  const colors = expandColors(shapes, options.cellColors, options.fallbackColor);
  const pick = (index: number) => onClick?.(shapes.cellIndices[index]);

  const data = {
    length: shapes.count,
    startIndices: shapes.startIndices,
    attributes: {
      getPolygon: { value: shapes.positions, size: 2 },
      getPath: { value: shapes.positions, size: 2 },
      getFillColor: { value: colors, size: 4 },
      getColor: { value: colors, size: 4 },
    },
  };

  // The fill layer is always present, even in outline mode where it renders
  // fully transparent: hovering or clicking a 1px outline is near impossible,
  // so the polygon interior is what carries picking.
  const fillOpacity = style === "outline" ? 0 : style === "both" ? opacity * 0.45 : opacity;
  const layers: Layer[] = [
    new SolidPolygonLayer({
      id: `${id}-fill`,
      data,
      // The rings come straight from WKB: already closed, no holes.
      _normalize: false,
      positionFormat: "XY",
      filled: true,
      opacity: fillOpacity,
      pickable: options.pickable ?? true,
      onClick: (info) => {
        pick(info.index);
        return true;
      },
    }),
  ];
  if (style === "outline" || style === "both") {
    layers.push(
      new PathLayer({
        id: `${id}-outline`,
        data,
        _pathType: "loop",
        positionFormat: "XY",
        widthUnits: "pixels",
        getWidth: 1,
        widthMinPixels: 1,
        opacity,
        pickable: false,
      }),
    );
  }
  return layers;
}

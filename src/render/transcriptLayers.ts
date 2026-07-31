import type { Layer } from "@deck.gl/core";
import { ScatterplotLayer } from "@deck.gl/layers";
import { UNKNOWN_FEATURE } from "../data/dataset";
import type { ViewportPoints } from "../data/transcripts";
import { type RGB, categoryColor } from "../ui/colormaps";

type Points = Extract<ViewportPoints, { tooMany: false }>;

/** Colour for transcripts the user has not singled out. */
const NEUTRAL: RGB = [150, 155, 165];

/**
 * Per-gene RGBA lookup, indexed by gene code with one extra slot on the end for
 * features that are not rows of `var`.
 *
 * Alpha carries visibility, exactly as it does for cells: hiding the
 * unhighlighted transcripts zeroes their alpha rather than filtering the
 * position buffer, so the worker never has to re-run the viewport query when
 * the gene selection changes.
 */
export function buildTranscriptLut(
  geneCount: number,
  highlighted: readonly number[],
  hideOthers: boolean,
): Uint8Array {
  const lut = new Uint8Array((geneCount + 1) * 4);
  // Highlighting nothing means every transcript is equally interesting, so they
  // all stay visible in the neutral colour rather than all disappearing.
  const othersAlpha = hideOthers && highlighted.length > 0 ? 0 : 255;
  for (let i = 0; i <= geneCount; i++) {
    lut[i * 4] = NEUTRAL[0];
    lut[i * 4 + 1] = NEUTRAL[1];
    lut[i * 4 + 2] = NEUTRAL[2];
    lut[i * 4 + 3] = othersAlpha;
  }
  highlighted.forEach((gene, i) => {
    if (gene < 0 || gene >= geneCount) return;
    const [r, g, b] = categoryColor(i);
    lut[gene * 4] = r;
    lut[gene * 4 + 1] = g;
    lut[gene * 4 + 2] = b;
    lut[gene * 4 + 3] = 255;
  });
  return lut;
}

/** Fans the per-gene lookup out to one RGBA per point. */
export function expandTranscriptColors(
  codes: Uint16Array,
  lut: Uint8Array,
  geneCount: number,
): Uint8Array {
  const out = new Uint8Array(codes.length * 4);
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    const slot = (code === UNKNOWN_FEATURE || code >= geneCount ? geneCount : code) * 4;
    out[i * 4] = lut[slot];
    out[i * 4 + 1] = lut[slot + 1];
    out[i * 4 + 2] = lut[slot + 2];
    out[i * 4 + 3] = lut[slot + 3];
  }
  return out;
}

export interface TranscriptLayerOptions {
  points: Points;
  colors: Uint8Array;
  pointSize: number;
  opacity: number;
}

export function buildTranscriptLayers(options: TranscriptLayerOptions): Layer[] {
  const { points, colors, pointSize, opacity } = options;
  if (points.count === 0) return [];
  return [
    new ScatterplotLayer({
      id: "transcripts",
      data: {
        length: points.count,
        attributes: {
          getPosition: { value: points.positions, size: 2 },
          getFillColor: { value: colors, size: 4 },
        },
      },
      // Screen-space radius: a transcript is a point detection, not an object
      // with an extent, so it should stay legible at every zoom rather than
      // growing into a blob.
      radiusUnits: "pixels",
      getRadius: pointSize,
      radiusMinPixels: 0.5,
      opacity,
      // Picking 1.5M points would cost a full-screen readback per hover for no
      // information the panel does not already show.
      pickable: false,
      updateTriggers: { getFillColor: colors },
    }),
  ];
}

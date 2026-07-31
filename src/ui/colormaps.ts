export type RGB = [number, number, number];

/**
 * Anchor points for the perceptually-uniform maps, sampled at even intervals.
 * Interpolating 9 anchors is visually indistinguishable from the full 256-entry
 * tables at the sizes we draw, and keeps this file readable.
 */
const ANCHORS: Record<string, RGB[]> = {
  viridis: [
    [68, 1, 84],
    [72, 40, 120],
    [62, 74, 137],
    [49, 104, 142],
    [38, 130, 142],
    [31, 158, 137],
    [53, 183, 121],
    [109, 205, 89],
    [180, 222, 44],
    [253, 231, 37],
  ],
  magma: [
    [0, 0, 4],
    [28, 16, 68],
    [79, 18, 123],
    [129, 37, 129],
    [181, 54, 122],
    [229, 80, 100],
    [251, 135, 97],
    [254, 194, 135],
    [252, 253, 191],
  ],
  plasma: [
    [13, 8, 135],
    [84, 2, 163],
    [139, 10, 165],
    [185, 50, 137],
    [219, 92, 104],
    [244, 136, 73],
    [254, 188, 43],
    [240, 249, 33],
  ],
  turbo: [
    [48, 18, 59],
    [70, 107, 227],
    [42, 175, 234],
    [30, 225, 158],
    [110, 254, 83],
    [199, 239, 52],
    [254, 183, 47],
    [242, 100, 24],
    [180, 27, 7],
    [122, 4, 3],
  ],
  grey: [
    [20, 20, 22],
    [245, 245, 245],
  ],
};

export const COLORMAP_NAMES = Object.keys(ANCHORS);

/** Samples a colormap at `t` in [0, 1]. */
export function sampleColormap(name: string, t: number): RGB {
  const anchors = ANCHORS[name] ?? ANCHORS.viridis;
  const clamped = Math.min(1, Math.max(0, t));
  const pos = clamped * (anchors.length - 1);
  const i = Math.min(anchors.length - 2, Math.floor(pos));
  const f = pos - i;
  const a = anchors[i];
  const b = anchors[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

export function colormapCss(name: string, stops = 12): string {
  const parts: string[] = [];
  for (let i = 0; i < stops; i++) {
    const [r, g, b] = sampleColormap(name, i / (stops - 1));
    parts.push(`rgb(${r},${g},${b})`);
  }
  return `linear-gradient(to right, ${parts.join(",")})`;
}

/**
 * Qualitative palette for categorical colouring. Ordered so that neighbouring
 * categories stay distinguishable, including for the common red/green
 * deficiencies.
 */
export const CATEGORY_COLORS: RGB[] = [
  [31, 119, 180],
  [255, 127, 14],
  [44, 160, 44],
  [214, 39, 40],
  [148, 103, 189],
  [140, 86, 75],
  [227, 119, 194],
  [127, 127, 127],
  [188, 189, 34],
  [23, 190, 207],
  [174, 199, 232],
  [255, 187, 120],
  [152, 223, 138],
  [255, 152, 150],
  [197, 176, 213],
  [196, 156, 148],
  [247, 182, 210],
  [199, 199, 199],
  [219, 219, 141],
  [158, 218, 229],
];

export function categoryColor(code: number): RGB {
  if (code < 0) return [110, 110, 110];
  return CATEGORY_COLORS[code % CATEGORY_COLORS.length];
}

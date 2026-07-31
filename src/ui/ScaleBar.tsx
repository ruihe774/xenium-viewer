import { useApp } from "../store";

/** 1-2-5 sequence, so the bar always reads as a round number. */
const NICE_STEPS = [1, 2, 5];

function niceLength(targetUm: number): number {
  const exponent = Math.floor(Math.log10(targetUm));
  const base = 10 ** exponent;
  for (const step of NICE_STEPS) {
    if (step * base >= targetUm) return step * base;
  }
  return 10 * base;
}

function format(um: number): string {
  if (um >= 1000) return `${um / 1000} mm`;
  return `${um} µm`;
}

export function ScaleBar() {
  const zoom = useApp((s) => s.viewZoom);
  const pixelSizeUm = useApp((s) => s.dataset?.pixelSizeUm);
  if (!pixelSizeUm) return null;

  // At orthographic zoom z, one level-0 image pixel covers 2**z screen pixels.
  const screenPxPerUm = 2 ** zoom / pixelSizeUm;
  const targetScreenPx = 120;
  const lengthUm = niceLength(targetScreenPx / screenPxPerUm);
  const widthPx = lengthUm * screenPxPerUm;

  return (
    <div className="scalebar">
      <div className="scalebar-bar" style={{ width: `${widthPx}px` }} />
      <span>{format(lengthUm)}</span>
    </div>
  );
}

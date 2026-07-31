import { useCallback, useRef } from "react";

interface Props {
  min: number;
  max: number;
  value: [number, number];
  onChange(value: [number, number]): void;
  /** Optional bin counts drawn behind the track, spanning [min, max]. */
  histogram?: number[];
  color?: [number, number, number];
  /** Quantisation of dragged values. Defaults to whole numbers. */
  step?: number;
}

/** Shows only as many decimals as the step can actually resolve. */
function display(value: number, step: number): string {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  return value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function roundTo(value: number, step: number): number {
  const snapped = Math.round(value / step) * step;
  // Kill the float noise that `x / 0.001` reintroduces.
  return Number(snapped.toFixed(Math.max(0, -Math.floor(Math.log10(step)))));
}

/**
 * Two-thumb range slider with an optional log-scaled histogram behind it.
 *
 * Intensity histograms are extremely bottom-heavy (background dominates), so
 * the bars use a log scale — a linear one renders as a single spike at zero.
 */
export function RangeSlider({ min, max, value, onChange, histogram, color, step = 1 }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [lo, hi] = value;
  const span = Math.max(1, max - min);
  const pct = (v: number) => ((v - min) / span) * 100;

  const startDrag = useCallback(
    (which: "lo" | "hi") => (event: React.PointerEvent) => {
      event.preventDefault();
      const track = trackRef.current;
      if (!track) return;
      const move = (e: PointerEvent) => {
        const rect = track.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        const next = roundTo(min + ratio * span, step);
        onChange(
          which === "lo"
            ? [Math.min(next, hi - step), hi]
            : [lo, Math.max(next, lo + step)],
        );
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [min, span, lo, hi, step, onChange],
  );

  const peak = histogram?.length ? Math.log1p(Math.max(...histogram)) : 1;
  const rgb = color ? `rgb(${color.join(",")})` : "var(--accent)";

  return (
    <div className="range">
      <div className="range-track" ref={trackRef}>
        {histogram && histogram.length > 0 && (
          <div className="range-hist">
            {histogram.map((count, i) => (
              // Bins are positional and fixed in number, so the index is a
              // stable identity here.
              <span
                key={i}
                style={{ height: `${(Math.log1p(count) / peak) * 100}%` }}
              />
            ))}
          </div>
        )}
        <div
          className="range-fill"
          style={{ left: `${pct(lo)}%`, right: `${100 - pct(hi)}%`, background: rgb }}
        />
        <button
          type="button"
          className="range-thumb"
          style={{ left: `${pct(lo)}%` }}
          onPointerDown={startDrag("lo")}
          aria-label="Lower contrast limit"
        />
        <button
          type="button"
          className="range-thumb"
          style={{ left: `${pct(hi)}%` }}
          onPointerDown={startDrag("hi")}
          aria-label="Upper contrast limit"
        />
      </div>
      <div className="range-values">
        <span>{display(lo, step)}</span>
        <span>{display(hi, step)}</span>
      </div>
    </div>
  );
}

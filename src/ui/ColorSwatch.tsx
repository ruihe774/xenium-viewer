import { useState } from "react";

export function swatchCss(color: [number, number, number]) {
  return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

/** Additive-blend friendly palette; matches the look of Xenium Explorer. */
export const SWATCH_PALETTE: [number, number, number][] = [
  [80, 130, 255],
  [0, 255, 140],
  [255, 120, 0],
  [255, 60, 160],
  [255, 255, 255],
  [255, 230, 0],
  [0, 220, 255],
  [180, 90, 255],
];

interface ColorSwatchProps {
  color: [number, number, number];
  onChange: (color: [number, number, number]) => void;
  /** Accessible label for the swatch button, e.g. "Colour for DAPI". */
  label: string;
  palette?: [number, number, number][];
}

/** A colour swatch button that opens a palette popover on click. */
export function ColorSwatch({
  color,
  onChange,
  label,
  palette = SWATCH_PALETTE,
}: ColorSwatchProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="swatch"
        style={{ background: swatchCss(color) }}
        onClick={() => setOpen((o) => !o)}
        aria-label={label}
      />
      {open && (
        <div className="palette">
          {palette.map((c) => (
            <button
              type="button"
              key={swatchCss(c)}
              className="swatch"
              style={{ background: swatchCss(c) }}
              onClick={() => {
                onChange(c);
                setOpen(false);
              }}
              aria-label={swatchCss(c)}
            />
          ))}
        </div>
      )}
    </>
  );
}

import { useState } from "react";
import { useApp } from "../store";
import { RangeSlider } from "./RangeSlider";

/** Additive-blend friendly palette; matches the look of Xenium Explorer. */
const PALETTE: [number, number, number][] = [
  [80, 130, 255],
  [0, 255, 140],
  [255, 120, 0],
  [255, 60, 160],
  [255, 255, 255],
  [255, 230, 0],
  [0, 220, 255],
  [180, 90, 255],
];

function css(color: [number, number, number]) {
  return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

export function ImagePanel() {
  const dataset = useApp((s) => s.dataset);
  const channels = useApp((s) => s.channels);
  const setChannel = useApp((s) => s.setChannel);
  const imageOpacity = useApp((s) => s.imageOpacity);
  const setImageOpacity = useApp((s) => s.setImageOpacity);
  const [openPalette, setOpenPalette] = useState<number>();

  const primary = dataset?.images.find((i) => i.name === "morphology_focus") ?? dataset?.images[0];
  if (!primary) return null;

  return (
    <section className="section">
      <h2>Image</h2>
      <div className="content">
        {channels.map((channel, i) => (
          <div className="channel" key={primary.channels[i].label}>
            <div className="channel-head">
              <input
                type="checkbox"
                checked={channel.visible}
                onChange={(e) => setChannel(i, { visible: e.target.checked })}
                aria-label={`Show ${primary.channels[i].label}`}
              />
              <button
                type="button"
                className="swatch"
                style={{ background: css(channel.color) }}
                onClick={() => setOpenPalette(openPalette === i ? undefined : i)}
                aria-label={`Colour for ${primary.channels[i].label}`}
              />
              <span className="channel-name" title={primary.channels[i].label}>
                {primary.channels[i].label}
              </span>
            </div>
            {openPalette === i && (
              <div className="palette">
                {PALETTE.map((color) => (
                  <button
                    type="button"
                    key={css(color)}
                    className="swatch"
                    style={{ background: css(color) }}
                    onClick={() => {
                      setChannel(i, { color });
                      setOpenPalette(undefined);
                    }}
                    aria-label={css(color)}
                  />
                ))}
              </div>
            )}
            <RangeSlider
              min={channel.domain[0]}
              max={channel.domain[1]}
              value={channel.contrastLimits}
              histogram={channel.histogram}
              color={channel.color}
              onChange={(contrastLimits) => setChannel(i, { contrastLimits })}
            />
          </div>
        ))}

        <label className="slider-row">
          <span>Opacity</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={imageOpacity}
            onChange={(e) => setImageOpacity(Number(e.target.value))}
          />
          <span className="num">{Math.round(imageOpacity * 100)}%</span>
        </label>
      </div>
    </section>
  );
}

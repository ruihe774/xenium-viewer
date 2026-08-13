import { useApp } from "../store";
import { ColorSwatch } from "./ColorSwatch";
import { RangeSlider } from "./RangeSlider";

export function ImagePanel() {
  const dataset = useApp((s) => s.dataset);
  const channels = useApp((s) => s.channels);
  const setChannel = useApp((s) => s.setChannel);
  const imageOpacity = useApp((s) => s.imageOpacity);
  const setImageOpacity = useApp((s) => s.setImageOpacity);

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
              <ColorSwatch
                color={channel.color}
                onChange={(color) => setChannel(i, { color })}
                label={`Colour for ${primary.channels[i].label}`}
              />
              <span className="channel-name" title={primary.channels[i].label}>
                {primary.channels[i].label}
              </span>
            </div>
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

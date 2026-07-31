import { useEffect, useRef } from "react";
import { useApp } from "../store";

const MAX_WIDTH = 130;
const MAX_HEIGHT = 300;

interface Props {
  /** Detail viewport bounds in level-0 pixels: [x0, y0, x1, y1]. */
  bounds?: readonly [number, number, number, number];
  imageWidth: number;
  imageHeight: number;
  onNavigate(x: number, y: number): void;
}

/**
 * Whole-slide navigator.
 *
 * Composited on the CPU from the per-channel thumbnails the stats pass already
 * produced (a few hundred pixels each), rather than as a second deck.gl view.
 * A second view would make Viv's tile layer load the entire lowest pyramid
 * level again just to fill a 130px box.
 */
export function Minimap({ bounds, imageWidth, imageHeight, onNavigate }: Props) {
  const channels = useApp((s) => s.channels);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const scale = Math.min(MAX_WIDTH / imageWidth, MAX_HEIGHT / imageHeight);
  const boxWidth = Math.round(imageWidth * scale);
  const boxHeight = Math.round(imageHeight * scale);

  useEffect(() => {
    const canvas = canvasRef.current;
    const thumb = channels.find((c) => c.thumbnail)?.thumbnail;
    if (!canvas || !thumb) return;

    const { width, height } = thumb;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const image = ctx.createImageData(width, height);
    const rgba = image.data;
    for (const channel of channels) {
      if (!channel.visible || !channel.thumbnail) continue;
      const { data } = channel.thumbnail;
      const [lo, hi] = channel.contrastLimits;
      const span = Math.max(1, hi - lo);
      const [r, g, b] = channel.color;
      for (let i = 0; i < data.length; i++) {
        const t = Math.min(1, Math.max(0, (data[i] - lo) / span));
        if (t === 0) continue;
        const o = i * 4;
        rgba[o] = Math.min(255, rgba[o] + t * r);
        rgba[o + 1] = Math.min(255, rgba[o + 1] + t * g);
        rgba[o + 2] = Math.min(255, rgba[o + 2] + t * b);
      }
    }
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    ctx.putImageData(image, 0, 0);
  }, [channels]);

  const rect = bounds && {
    left: `${(bounds[0] / imageWidth) * 100}%`,
    top: `${(bounds[1] / imageHeight) * 100}%`,
    width: `${((bounds[2] - bounds[0]) / imageWidth) * 100}%`,
    height: `${((bounds[3] - bounds[1]) / imageHeight) * 100}%`,
  };

  return (
    <div
      className="minimap"
      style={{ width: boxWidth, height: boxHeight }}
      onPointerDown={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onNavigate(
          ((e.clientX - r.left) / r.width) * imageWidth,
          ((e.clientY - r.top) / r.height) * imageHeight,
        );
      }}
    >
      <canvas ref={canvasRef} />
      {rect && <div className="minimap-rect" style={rect} />}
    </div>
  );
}

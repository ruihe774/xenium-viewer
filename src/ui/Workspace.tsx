import { Viewer } from "../render/Viewer";
import type { Dataset } from "../data/dataset";
import { useApp } from "../store";
import { CellInspector } from "./CellInspector";
import { CellsPanel } from "./CellsPanel";
import { DatasetSummary } from "./DatasetSummary";
import { GroupsPanel } from "./GroupsPanel";
import { ImagePanel } from "./ImagePanel";

/**
 * The whole ready-state UI, in its own module so `App` can lazy-load it.
 *
 * This is the split point that keeps deck.gl, luma.gl and Viv — ~1 MB, the
 * bulk of the bundle — out of the entry chunk: nothing reachable from the
 * welcome screen imports them, and they are only needed once a store is open.
 */
export function Workspace({ dataset }: { dataset: Dataset }) {
  const { reset, viewZoom } = useApp();

  // Orthographic zoom 0 means one image pixel per screen pixel.
  const umPerScreenPx = dataset.pixelSizeUm / 2 ** viewZoom;

  return (
    <div className="app">
      <header className="topbar">
        <span className="title">Xenium Viewer</span>
        <span className="subtitle">{dataset.name}</span>
        <span className="spacer" />
        <span className="subtitle">{umPerScreenPx.toPrecision(3)} µm / px</span>
        <button onClick={reset}>Close</button>
      </header>
      <div className="body">
        <aside className="sidebar">
          <ImagePanel />
          <CellsPanel />
          <GroupsPanel />
          <CellInspector />
          <DatasetSummary />
        </aside>
        <main className="stage">
          <Viewer />
        </main>
      </div>
    </div>
  );
}

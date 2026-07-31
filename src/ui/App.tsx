import { Viewer } from "../render/Viewer";
import { useApp } from "../store";
import { CellInspector } from "./CellInspector";
import { CellsPanel } from "./CellsPanel";
import { DatasetSummary } from "./DatasetSummary";
import { GroupsPanel } from "./GroupsPanel";
import { ImagePanel } from "./ImagePanel";
import { OpenDialog } from "./OpenDialog";

export function App() {
  const { status, dataset, reset, viewZoom } = useApp();

  if (status !== "ready" || !dataset) return <OpenDialog />;

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

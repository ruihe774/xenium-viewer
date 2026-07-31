import { Suspense, lazy, useEffect } from "react";
import { useApp } from "../store";
import { OpenDialog } from "./OpenDialog";

/**
 * Lazy so the entry chunk carries only the welcome screen. `lazy` alone would
 * serialize the download after the dataset resolves, so `prefetch` is fired as
 * soon as a store starts opening — the chunk then arrives alongside the zarr
 * metadata rather than after it.
 */
const importWorkspace = () => import("./Workspace");
const Workspace = lazy(() => importWorkspace().then((m) => ({ default: m.Workspace })));

export function App() {
  const { status, dataset } = useApp();

  useEffect(() => {
    if (status === "loading") void importWorkspace();
  }, [status]);

  if (status !== "ready" || !dataset) return <OpenDialog />;

  return (
    <Suspense fallback={<div className="app" />}>
      <Workspace dataset={dataset} />
    </Suspense>
  );
}

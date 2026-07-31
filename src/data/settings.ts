import type { CellColoring } from "../store";

/**
 * Display preferences that survive a reload, keyed by dataset.
 *
 * Only user choices are stored — never the derived data (histograms,
 * thumbnails, per-cell colours), which is both large and cheap to recompute.
 */
export interface StoredSettings {
  channels?: {
    visible: boolean;
    color: [number, number, number];
    contrastLimits: [number, number];
  }[];
  showCells?: boolean;
  showCellBoundaries?: boolean;
  showNucleusBoundaries?: boolean;
  boundaryStyle?: "outline" | "fill" | "both";
  cellOpacity?: number;
  imageOpacity?: number;
  cellColoring?: CellColoring;
}

const PREFIX = "xenium-viewer:v1:";

export function loadSettings(datasetName: string): StoredSettings {
  try {
    const raw = localStorage.getItem(PREFIX + datasetName);
    return raw ? (JSON.parse(raw) as StoredSettings) : {};
  } catch {
    // Corrupt or unavailable storage should never block opening a dataset.
    return {};
  }
}

export function saveSettings(datasetName: string, settings: StoredSettings): void {
  try {
    localStorage.setItem(PREFIX + datasetName, JSON.stringify(settings));
  } catch {
    // Quota or private-mode failures are not worth surfacing.
  }
}

export function clearSettings(datasetName: string): void {
  try {
    localStorage.removeItem(PREFIX + datasetName);
  } catch {
    // Unavailable storage should never block the caller.
  }
}

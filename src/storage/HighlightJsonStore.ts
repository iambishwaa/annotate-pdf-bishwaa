import PdfHighlighterBishwaaPlugin from "../main";
import { RectOverlay } from "../highlight/SelectionExtractor";

export interface HighlightModel {
  id: string;
  page: number;
  rects: RectOverlay[];
  text: string;
  color: string;
  opacity: number;
  author: string;
  timestamp: number;
}

interface HighlightFileMap {
  [pdfFilePath: string]: {
    highlights: HighlightModel[];
  };
}

// Typed wrapper for what loadData() returns so we never touch `any`
interface PluginData {
  fileMap: HighlightFileMap;
}

function parsePluginData(raw: unknown): PluginData {
  if (raw && typeof raw === "object" && "fileMap" in raw) {
    return raw as PluginData;
  }
  return { fileMap: {} };
}

export class HighlightJsonStore {
  plugin: PdfHighlighterBishwaaPlugin;

  constructor(plugin: PdfHighlighterBishwaaPlugin) {
    this.plugin = plugin;
  }

  async saveHighlight(pdfPath: string, highlight: HighlightModel) {
    await this.saveHighlightsBatch(pdfPath, [highlight]);
  }

  async saveHighlightsBatch(pdfPath: string, highlights: HighlightModel[]) {
    const data = parsePluginData(await this.plugin.loadData());

    if (!data.fileMap[pdfPath]) {
      data.fileMap[pdfPath] = { highlights: [] };
    }
    data.fileMap[pdfPath].highlights.push(...highlights);

    await this.plugin.saveData(data);
  }

  async loadHighlights(pdfPath: string): Promise<HighlightModel[]> {
    const data = parsePluginData(await this.plugin.loadData());
    return data.fileMap[pdfPath]?.highlights ?? [];
  }

  async applyBatchUpdatesToJson(
    pdfPath: string,
    highlightsToAdd: HighlightModel[],
    idsToDelete: string[],
  ) {
    const data = parsePluginData(await this.plugin.loadData());

    if (!data.fileMap[pdfPath]) {
      data.fileMap[pdfPath] = { highlights: [] };
    }

    if (idsToDelete.length > 0) {
      data.fileMap[pdfPath].highlights = data.fileMap[
        pdfPath
      ].highlights.filter((h) => !idsToDelete.includes(h.id));
    }

    if (highlightsToAdd.length > 0) {
      data.fileMap[pdfPath].highlights.push(...highlightsToAdd);
    }

    await this.plugin.saveData(data);
  }
}

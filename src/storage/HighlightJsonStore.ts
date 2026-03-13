import PdfHighlighterBishwaaPlugin from '../main';
import { RectOverlay } from '../highlight/SelectionExtractor';

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

export class HighlightJsonStore {
    plugin: PdfHighlighterBishwaaPlugin;

    constructor(plugin: PdfHighlighterBishwaaPlugin) {
        this.plugin = plugin;
    }

    async saveHighlight(pdfPath: string, highlight: HighlightModel) {
        await this.saveHighlightsBatch(pdfPath, [highlight]);
    }

    async saveHighlightsBatch(pdfPath: string, highlights: HighlightModel[]) {
        const data = await this.plugin.loadData() || {};
        const state: HighlightFileMap = data.fileMap || {};
        
        if (!state[pdfPath]) {
            state[pdfPath] = { highlights: [] };
        }
        
        state[pdfPath].highlights.push(...highlights);
        
        data.fileMap = state;
        await this.plugin.saveData(data);
    }

    async loadHighlights(pdfPath: string): Promise<HighlightModel[]> {
        const data = await this.plugin.loadData() || {};
        const state: HighlightFileMap = data.fileMap || {};
        
        if (!state[pdfPath] || !state[pdfPath].highlights) {
            return [];
        }
        
        return state[pdfPath].highlights;
    }

    async applyBatchUpdatesToJson(pdfPath: string, highlightsToAdd: HighlightModel[], idsToDelete: string[]) {
        const data = await this.plugin.loadData() || {};
        const state: HighlightFileMap = data.fileMap || {};
        
        if (!state[pdfPath]) {
            state[pdfPath] = { highlights: [] };
        }
        
        if (idsToDelete.length > 0) {
            state[pdfPath].highlights = state[pdfPath].highlights.filter(h => !idsToDelete.includes(h.id));
        }

        if (highlightsToAdd.length > 0) {
            state[pdfPath].highlights.push(...highlightsToAdd);
        }
        
        data.fileMap = state;
        await this.plugin.saveData(data);
    }
}

import { __awaiter } from "tslib";
import { Plugin, PluginSettingTab, Setting, Notice, TFile, View, } from "obsidian";
import { SelectionExtractor, } from "./highlight/SelectionExtractor";
import { HighlightJsonStore } from "./storage/HighlightJsonStore";
import { PdfAnnotator, EncryptedPdfError, LockedPdfError, } from "./pdf/PdfAnnotator";
const DEFAULT_SETTINGS = {
    hexColorPrimary: "#ffff00",
    hexColorSecondary: "#00ff00",
    hexColorTertiary: "#00ffff",
    opacity: 40,
    author: "Obsidian User",
    unflushedHighlights: {},
    unflushedDeletions: {},
};
function hexToRgbArray(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
        ? [
            parseInt(result[1], 16) / 255,
            parseInt(result[2], 16) / 255,
            parseInt(result[3], 16) / 255,
        ]
        : [1, 1, 0];
}
export default class PdfHighlighterBishwaaPlugin extends Plugin {
    constructor() {
        super(...arguments);
        this.pendingHighlights = new Map();
        this.pendingDeletions = new Map();
        // Concurrency guard
        this._isFlushing = false;
        this._flushPending = false;
        this._encryptedFiles = new Set();
    }
    onload() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.loadSettings();
            if (this.settings.unflushedHighlights) {
                for (const [k, v] of Object.entries(this.settings.unflushedHighlights)) {
                    this.pendingHighlights.set(k, v);
                }
            }
            if (this.settings.unflushedDeletions) {
                for (const [k, v] of Object.entries(this.settings.unflushedDeletions)) {
                    this.pendingDeletions.set(k, v);
                }
            }
            this.highlightStore = new HighlightJsonStore(this);
            this.selectionExtractor = new SelectionExtractor();
            this.pdfAnnotator = new PdfAnnotator(this.app);
            this.addSettingTab(new PdfHighlighterSettingTab(this.app, this));
            setTimeout(() => void this.flushCache(), 3000);
            this.registerInterval(window.setInterval(() => this.reinjectCssOverlays(), 1500));
            this.addCommand({
                id: "highlight-pdf-primary",
                name: "Highlight selected PDF text (primary)",
                checkCallback: (checking) => {
                    var _a;
                    if (((_a = this.app.workspace.getActiveViewOfType(View)) === null || _a === void 0 ? void 0 : _a.getViewType()) === "pdf") {
                        if (!checking)
                            void this.executeHighlight(this.settings.hexColorPrimary);
                        return true;
                    }
                    return false;
                },
            });
            this.addCommand({
                id: "highlight-pdf-secondary",
                name: "Highlight selected PDF text (secondary)",
                checkCallback: (checking) => {
                    var _a;
                    if (((_a = this.app.workspace.getActiveViewOfType(View)) === null || _a === void 0 ? void 0 : _a.getViewType()) === "pdf") {
                        if (!checking)
                            void this.executeHighlight(this.settings.hexColorSecondary);
                        return true;
                    }
                    return false;
                },
            });
            this.addCommand({
                id: "highlight-pdf-tertiary",
                name: "Highlight selected PDF text (tertiary)",
                checkCallback: (checking) => {
                    var _a;
                    if (((_a = this.app.workspace.getActiveViewOfType(View)) === null || _a === void 0 ? void 0 : _a.getViewType()) === "pdf") {
                        if (!checking)
                            void this.executeHighlight(this.settings.hexColorTertiary);
                        return true;
                    }
                    return false;
                },
            });
            this.addCommand({
                id: "remove-pdf-highlight",
                name: "Remove highlight under selection",
                checkCallback: (checking) => {
                    var _a;
                    if (((_a = this.app.workspace.getActiveViewOfType(View)) === null || _a === void 0 ? void 0 : _a.getViewType()) === "pdf") {
                        if (!checking)
                            void this.executeRemoveHighlight();
                        return true;
                    }
                    return false;
                },
            });
            this.registerDomEvent(document, "keydown", (evt) => {
                var _a;
                if (((_a = this.app.workspace.getActiveViewOfType(View)) === null || _a === void 0 ? void 0 : _a.getViewType()) !== "pdf")
                    return;
                const target = evt.target;
                if ((target === null || target === void 0 ? void 0 : target.tagName) === "INPUT" ||
                    (target === null || target === void 0 ? void 0 : target.tagName) === "TEXTAREA" ||
                    (target === null || target === void 0 ? void 0 : target.isContentEditable))
                    return;
                const selection = window.getSelection();
                const hasSelection = selection &&
                    !selection.isCollapsed &&
                    selection.toString().trim().length > 0;
                if (evt.key.toLowerCase() === "h" && hasSelection) {
                    void this.executeHighlight(this.settings.hexColorPrimary);
                    evt.preventDefault();
                }
                else if (evt.key.toLowerCase() === "g" && hasSelection) {
                    void this.executeHighlight(this.settings.hexColorSecondary);
                    evt.preventDefault();
                }
                else if (evt.key.toLowerCase() === "j" && hasSelection) {
                    void this.executeHighlight(this.settings.hexColorTertiary);
                    evt.preventDefault();
                }
                else if ((evt.key === "Delete" || evt.key === "Backspace") &&
                    hasSelection) {
                    void this.executeRemoveHighlight();
                    evt.preventDefault();
                }
            });
            this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.flushCache()));
            this.registerEvent(this.app.workspace.on("quit", () => this.flushCache()));
            console.debug("AnnotatePDF by bishwaa loaded");
        });
    }
    // ─── Concurrency-safe flush ───────────────────────────────────────────────
    flushCache() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this._isFlushing) {
                this._flushPending = true;
                return;
            }
            this._isFlushing = true;
            this._flushPending = false;
            try {
                yield this._doFlush();
            }
            finally {
                this._isFlushing = false;
                if (this._flushPending) {
                    this._flushPending = false;
                    setTimeout(() => void this.flushCache(), 50);
                }
            }
        });
    }
    _doFlush() {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            if (this.pendingHighlights.size === 0 && this.pendingDeletions.size === 0)
                return;
            const highlightsToProcess = new Map(this.pendingHighlights);
            const deletionsToProcess = new Map(this.pendingDeletions);
            const allPaths = new Set([
                ...highlightsToProcess.keys(),
                ...deletionsToProcess.keys(),
            ]);
            for (const filePath of allPaths) {
                if (this._encryptedFiles.has(filePath))
                    continue;
                const file = this.app.vault.getAbstractFileByPath(filePath);
                if (!(file instanceof TFile))
                    continue;
                const highlights = (_a = highlightsToProcess.get(filePath)) !== null && _a !== void 0 ? _a : [];
                const deletions = (_b = deletionsToProcess.get(filePath)) !== null && _b !== void 0 ? _b : [];
                if (highlights.length === 0 && deletions.length === 0)
                    continue;
                try {
                    yield this.pdfAnnotator.applyBatchUpdatesToPdf(file, highlights, deletions);
                    const bulkJsonElements = highlights.map((p) => ({
                        id: p.id,
                        page: p.pageNumber,
                        rects: p.rects,
                        text: "Bulk Annotated Data",
                        color: `rgb(${Math.round(p.colorRgb[0] * 255)}, ${Math.round(p.colorRgb[1] * 255)}, ${Math.round(p.colorRgb[2] * 255)})`,
                        opacity: p.opacity,
                        author: p.author,
                        timestamp: Date.now(),
                    }));
                    const exactIdsToDelete = deletions.filter((id) => !id.startsWith("SPATIAL:"));
                    yield this.highlightStore.applyBatchUpdatesToJson(filePath, bulkJsonElements, exactIdsToDelete);
                    this.pendingHighlights.delete(filePath);
                    this.pendingDeletions.delete(filePath);
                    yield this.syncPendingQueueToDisk();
                    if (highlights.length > 0) {
                        new Notice(`✅ Highlights saved to ${file.name}`);
                    }
                }
                catch (e) {
                    if (e instanceof EncryptedPdfError) {
                        new Notice(`🔒 "${file.name}" is password-protected.\n\nAnnotatePDF cannot modify encrypted PDFs. Highlights have been discarded.`, 8000);
                        // Clear queue so we never retry this file
                        this.pendingHighlights.delete(filePath);
                        this.pendingDeletions.delete(filePath);
                        this._encryptedFiles.add(filePath);
                        yield this.syncPendingQueueToDisk();
                    }
                    else if (e instanceof LockedPdfError) {
                        new Notice(`❌ "${file.name}" is open in another app.\n\nClose it there first, then switch tabs to save your highlights.`, 6000);
                    }
                    else {
                        // ── Unknown error ─────────────────────────────────────────────────
                        new Notice(`⚠️ Failed to save highlights to "${file.name}".\n\nCheck the developer console for details.`, 6000);
                    }
                    console.error("[AnnotatePDF] Flush error:", e);
                }
            }
        });
    }
    syncPendingQueueToDisk() {
        return __awaiter(this, void 0, void 0, function* () {
            this.settings.unflushedHighlights = Object.fromEntries(this.pendingHighlights);
            this.settings.unflushedDeletions = Object.fromEntries(this.pendingDeletions);
            yield this.saveSettings();
        });
    }
    executeHighlight(colorHex) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const activeFile = this.app.workspace.getActiveFile();
            if (!activeFile || activeFile.extension !== "pdf")
                return;
            if (this._encryptedFiles.has(activeFile.path)) {
                new Notice(`🔒 "${activeFile.name}" is password-protected and cannot be annotated.`);
                return;
            }
            const selectionData = this.selectionExtractor.getActiveSelection();
            if (!selectionData || selectionData.rects.length === 0) {
                new Notice("No text selected to highlight");
                return;
            }
            const opacityFloat = this.settings.opacity / 100;
            const colorArray = hexToRgbArray(colorHex);
            const highlightId = window.crypto.randomUUID();
            this.drawTemporaryCssOverlay(selectionData.pageNumber, selectionData.rects, colorHex, opacityFloat);
            const payload = {
                pageNumber: selectionData.pageNumber,
                rects: selectionData.rects,
                colorRgb: colorArray,
                opacity: opacityFloat,
                author: this.settings.author,
                id: highlightId,
            };
            const existing = (_a = this.pendingHighlights.get(activeFile.path)) !== null && _a !== void 0 ? _a : [];
            existing.push(payload);
            this.pendingHighlights.set(activeFile.path, existing);
            yield this.syncPendingQueueToDisk();
            (_b = window.getSelection()) === null || _b === void 0 ? void 0 : _b.empty();
        });
    }
    executeRemoveHighlight() {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const activeFile = this.app.workspace.getActiveFile();
            if (!activeFile || activeFile.extension !== "pdf")
                return;
            if (this._encryptedFiles.has(activeFile.path)) {
                new Notice(`🔒 "${activeFile.name}" is password-protected and cannot be modified.`);
                return;
            }
            const selectionData = this.selectionExtractor.getActiveSelection();
            if (!selectionData || selectionData.rects.length === 0)
                return;
            const cursorRect = selectionData.rects[0];
            if (!cursorRect)
                return;
            (_a = window.getSelection()) === null || _a === void 0 ? void 0 : _a.empty();
            // Step 1: pending queue
            const qList = this.pendingHighlights.get(activeFile.path);
            if (qList && qList.length > 0) {
                const before = qList.length;
                const filtered = qList.filter((p) => !this.checkIntersection(p.pageNumber, p.rects, selectionData.pageNumber, cursorRect));
                if (filtered.length < before) {
                    this.pendingHighlights.set(activeFile.path, filtered);
                    this.removeTemporaryCssOverlay(cursorRect, selectionData.pageNumber);
                    yield this.syncPendingQueueToDisk();
                    new Notice(`🗑️ Queued highlight cancelled`);
                    return;
                }
            }
            // Step 2: read directly from PDF binary
            let savedAnnotations;
            try {
                savedAnnotations =
                    yield this.pdfAnnotator.readAnnotationsFromPdf(activeFile);
            }
            catch (e) {
                if (e instanceof EncryptedPdfError) {
                    this._encryptedFiles.add(activeFile.path);
                    new Notice(`🔒 "${activeFile.name}" is password-protected and cannot be modified.`);
                    return;
                }
                new Notice(`⚠️ Could not read "${activeFile.name}". Check the console for details.`);
                return;
            }
            if (savedAnnotations.length === 0) {
                new Notice(`⚠️ No saved highlights found in this PDF`);
                return;
            }
            const margin = 0.005;
            const target = savedAnnotations.find((ann) => {
                if (ann.pageNumber !== selectionData.pageNumber)
                    return false;
                return (cursorRect.pLeft <= ann.pLeft + ann.pWidth + margin &&
                    cursorRect.pLeft + cursorRect.pWidth >= ann.pLeft - margin &&
                    cursorRect.pTop <= ann.pTop + ann.pHeight + margin &&
                    cursorRect.pTop + cursorRect.pHeight >= ann.pTop - margin);
            });
            if (!target) {
                new Notice(`⚠️ No highlight found at the selected position`);
                return;
            }
            const delQ = (_b = this.pendingDeletions.get(activeFile.path)) !== null && _b !== void 0 ? _b : [];
            if (target.id)
                delQ.push(target.id);
            delQ.push(`SPATIAL:${target.pageNumber}:${target.pLeft},${target.pTop},${target.pWidth},${target.pHeight}`);
            this.pendingDeletions.set(activeFile.path, delQ);
            yield this.syncPendingQueueToDisk();
            yield this.flushCache();
        });
    }
    // ─── CSS overlay helpers ──────────────────────────────────────────────────
    drawTemporaryCssOverlay(pageNumber, rects, colorHex, opacityFloat) {
        var _a;
        const container = (_a = this.app.workspace.getActiveViewOfType(View)) === null || _a === void 0 ? void 0 : _a.containerEl;
        if (!container)
            return;
        const pageDiv = container.querySelector(`.page[data-page-number="${pageNumber}"]`);
        if (!pageDiv)
            return;
        // After
        let tempLayer = pageDiv.querySelector(".temp-highlights-layer");
        if (!tempLayer) {
            tempLayer = document.createElement("div");
            tempLayer.addClass("temp-highlights-layer");
            pageDiv.appendChild(tempLayer);
        }
        for (const r of rects) {
            const el = document.createElement("div");
            el.addClass("temp-highlight-rect");
            el.setCssProps({
                left: `${r.pLeft * 100}%`,
                top: `${r.pTop * 100}%`,
                width: `${r.pWidth * 100}%`,
                height: `${r.pHeight * 100}%`,
                "background-color": colorHex,
                opacity: opacityFloat.toString(),
            });
            tempLayer.appendChild(el);
        }
    }
    removeTemporaryCssOverlay(cursorRect, pageNumber) {
        var _a;
        const container = (_a = this.app.workspace.getActiveViewOfType(View)) === null || _a === void 0 ? void 0 : _a.containerEl;
        if (!container)
            return;
        const pageDiv = container.querySelector(`.page[data-page-number="${pageNumber}"]`);
        const tempLayer = pageDiv === null || pageDiv === void 0 ? void 0 : pageDiv.querySelector(".temp-highlights-layer");
        if (!tempLayer)
            return;
        for (const el of Array.from(tempLayer.children)) {
            const l = parseFloat(el.style.left) / 100;
            const w = parseFloat(el.style.width) / 100;
            const t = parseFloat(el.style.top) / 100;
            const h = parseFloat(el.style.height) / 100;
            if (cursorRect.pLeft <= l + w &&
                cursorRect.pLeft + cursorRect.pWidth >= l &&
                cursorRect.pTop <= t + h &&
                cursorRect.pTop + cursorRect.pHeight >= t)
                el.remove();
        }
    }
    reinjectCssOverlays() {
        var _a, _b;
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || activeFile.extension !== "pdf")
            return;
        const pending = this.pendingHighlights.get(activeFile.path);
        if (!pending || pending.length === 0)
            return;
        const container = (_a = this.app.workspace.getActiveViewOfType(View)) === null || _a === void 0 ? void 0 : _a.containerEl;
        if (!container)
            return;
        const byPage = new Map();
        for (const p of pending) {
            const arr = (_b = byPage.get(p.pageNumber)) !== null && _b !== void 0 ? _b : [];
            arr.push(p);
            byPage.set(p.pageNumber, arr);
        }
        for (const [pageNumber, highlights] of byPage.entries()) {
            const pageDiv = container.querySelector(`.page[data-page-number="${pageNumber}"]`);
            if (!pageDiv || pageDiv.querySelector(".temp-highlights-layer"))
                continue;
            for (const hl of highlights) {
                const cssColor = `rgb(${Math.round(hl.colorRgb[0] * 255)}, ${Math.round(hl.colorRgb[1] * 255)}, ${Math.round(hl.colorRgb[2] * 255)})`;
                this.drawTemporaryCssOverlay(hl.pageNumber, hl.rects, cssColor, hl.opacity);
            }
        }
    }
    checkIntersection(hlPage, hlRects, cursorPage, cursorRect) {
        if (hlPage !== cursorPage)
            return false;
        const margin = 0.005;
        for (const r of hlRects) {
            if (cursorRect.pLeft <= r.pLeft + r.pWidth + margin &&
                cursorRect.pLeft + cursorRect.pWidth >= r.pLeft - margin &&
                cursorRect.pTop <= r.pTop + r.pHeight + margin &&
                cursorRect.pTop + cursorRect.pHeight >= r.pTop - margin)
                return true;
        }
        return false;
    }
    onunload() {
        this.syncPendingQueueToDisk().catch(console.error);
        this.flushCache().catch(console.error);
        console.debug("AnnotatePDF by bishwaa unloaded");
    }
    loadSettings() {
        return __awaiter(this, void 0, void 0, function* () {
            this.settings = Object.assign({}, DEFAULT_SETTINGS, (yield this.loadData()));
        });
    }
    saveSettings() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.saveData(this.settings);
        });
    }
}
class PdfHighlighterSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }
    display() {
        const { containerEl } = this;
        containerEl.empty();
        new Setting(containerEl).setName("Annotate PDF").setHeading();
        new Setting(containerEl)
            .setName("Author name")
            .setDesc("Stored natively in the PDF annotation metadata.")
            .addText((text) => text.setValue(this.plugin.settings.author).onChange((value) => __awaiter(this, void 0, void 0, function* () {
            this.plugin.settings.author = value;
            yield this.plugin.saveSettings();
        })));
        new Setting(containerEl)
            .setName("Primary color (hotkey: h)")
            .addColorPicker((color) => color
            .setValue(this.plugin.settings.hexColorPrimary)
            .onChange((value) => __awaiter(this, void 0, void 0, function* () {
            this.plugin.settings.hexColorPrimary = value;
            yield this.plugin.saveSettings();
        })));
        new Setting(containerEl)
            .setName("Secondary color (hotkey: g)")
            .addColorPicker((color) => color
            .setValue(this.plugin.settings.hexColorSecondary)
            .onChange((value) => __awaiter(this, void 0, void 0, function* () {
            this.plugin.settings.hexColorSecondary = value;
            yield this.plugin.saveSettings();
        })));
        new Setting(containerEl)
            .setName("Tertiary color (hotkey: j)")
            .addColorPicker((color) => color
            .setValue(this.plugin.settings.hexColorTertiary)
            .onChange((value) => __awaiter(this, void 0, void 0, function* () {
            this.plugin.settings.hexColorTertiary = value;
            yield this.plugin.saveSettings();
        })));
        new Setting(containerEl)
            .setName("Highlight opacity")
            .setDesc("Native PDF alpha opacity (0–100).")
            .addSlider((slider) => slider
            .setLimits(0, 100, 1)
            .setValue(this.plugin.settings.opacity)
            .setDynamicTooltip()
            .onChange((value) => __awaiter(this, void 0, void 0, function* () {
            this.plugin.settings.opacity = value;
            yield this.plugin.saveSettings();
        })));
        new Setting(containerEl)
            .setName("Reset cache")
            .setDesc("Clears all pending queues, the JSON audit log, and the encrypted-file blocklist. " +
            "Use this if you removed a password from a PDF and want to annotate it again.")
            .addButton((btn) => btn
            .setButtonText("Reset")
            .setWarning()
            .onClick(() => __awaiter(this, void 0, void 0, function* () {
            this.plugin.pendingHighlights.clear();
            this.plugin.pendingDeletions.clear();
            this.plugin.settings.unflushedHighlights = {};
            this.plugin.settings.unflushedDeletions = {};
            this.plugin._encryptedFiles.clear(); // allow retrying previously blocked files
            yield this.plugin.saveData({ fileMap: {} });
            yield this.plugin.saveSettings();
            new Notice(`✅ Cache reset`);
        })));
    }
}
// bishwaababu
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1haW4udHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBLE9BQU8sRUFFTCxNQUFNLEVBQ04sZ0JBQWdCLEVBQ2hCLE9BQU8sRUFDUCxNQUFNLEVBQ04sS0FBSyxFQUNMLElBQUksR0FDTCxNQUFNLFVBQVUsQ0FBQztBQUVsQixPQUFPLEVBQ0wsa0JBQWtCLEdBRW5CLE1BQU0sZ0NBQWdDLENBQUM7QUFDeEMsT0FBTyxFQUFFLGtCQUFrQixFQUFFLE1BQU0sOEJBQThCLENBQUM7QUFDbEUsT0FBTyxFQUNMLFlBQVksRUFFWixpQkFBaUIsRUFDakIsY0FBYyxHQUNmLE1BQU0sb0JBQW9CLENBQUM7QUFZNUIsTUFBTSxnQkFBZ0IsR0FBMkI7SUFDL0MsZUFBZSxFQUFFLFNBQVM7SUFDMUIsaUJBQWlCLEVBQUUsU0FBUztJQUM1QixnQkFBZ0IsRUFBRSxTQUFTO0lBQzNCLE9BQU8sRUFBRSxFQUFFO0lBQ1gsTUFBTSxFQUFFLGVBQWU7SUFDdkIsbUJBQW1CLEVBQUUsRUFBRTtJQUN2QixrQkFBa0IsRUFBRSxFQUFFO0NBQ3ZCLENBQUM7QUFFRixTQUFTLGFBQWEsQ0FBQyxHQUFXO0lBQ2hDLE1BQU0sTUFBTSxHQUFHLDJDQUEyQyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUNyRSxPQUFPLE1BQU07UUFDWCxDQUFDLENBQUM7WUFDRSxRQUFRLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBVyxFQUFFLEVBQUUsQ0FBQyxHQUFHLEdBQUc7WUFDdkMsUUFBUSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQVcsRUFBRSxFQUFFLENBQUMsR0FBRyxHQUFHO1lBQ3ZDLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFXLEVBQUUsRUFBRSxDQUFDLEdBQUcsR0FBRztTQUN4QztRQUNILENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUM7QUFDaEIsQ0FBQztB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IjpbImltcG9ydCB7XG4gIEFwcCxcbiAgUGx1Z2luLFxuICBQbHVnaW5TZXR0aW5nVGFiLFxuICBTZXR0aW5nLFxuICBOb3RpY2UsXG4gIFRGaWxlLFxuICBWaWV3LFxufSBmcm9tIFwib2JzaWRpYW5cIjtcblxuaW1wb3J0IHtcbiAgU2VsZWN0aW9uRXh0cmFjdG9yLFxuICBSZWN0T3ZlcmxheSxcbn0gZnJvbSBcIi4vaGlnaGxpZ2h0L1NlbGVjdGlvbkV4dHJhY3RvclwiO1xuaW1wb3J0IHsgSGlnaGxpZ2h0SnNvblN0b3JlIH0gZnJvbSBcIi4vc3RvcmFnZS9IaWdobGlnaHRKc29uU3RvcmVcIjtcbmltcG9ydCB7XG4gIFBkZkFubm90YXRvcixcbiAgUGRmSGlnaGxpZ2h0UGF5bG9hZCxcbiAgRW5jcnlwdGVkUGRmRXJyb3IsXG4gIExvY2tlZFBkZkVycm9yLFxufSBmcm9tIFwiLi9wZGYvUGRmQW5ub3RhdG9yXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgUGRmSGlnaGxpZ2h0ZXJTZXR0aW5ncyB7XG4gIGhleENvbG9yUHJpbWFyeTogc3RyaW5nO1xuICBoZXhDb2xvclNlY29uZGFyeTogc3RyaW5nO1xuICBoZXhDb2xvclRlcnRpYXJ5OiBzdHJpbmc7XG4gIG9wYWNpdHk6IG51bWJlcjtcbiAgYXV0aG9yOiBzdHJpbmc7XG4gIHVuZmx1c2hlZEhpZ2hsaWdodHM6IFJlY29yZDxzdHJpbmcsIFBkZkhpZ2hsaWdodFBheWxvYWRbXT47XG4gIHVuZmx1c2hlZERlbGV0aW9uczogUmVjb3JkPHN0cmluZywgc3RyaW5nW10+O1xufVxuXG5jb25zdCBERUZBVUxUX1NFVFRJTkdTOiBQZGZIaWdobGlnaHRlclNldHRpbmdzID0ge1xuICBoZXhDb2xvclByaW1hcnk6IFwiI2ZmZmYwMFwiLFxuICBoZXhDb2xvclNlY29uZGFyeTogXCIjMDBmZjAwXCIsXG4gIGhleENvbG9yVGVydGlhcnk6IFwiIzAwZmZmZlwiLFxuICBvcGFjaXR5OiA0MCxcbiAgYXV0aG9yOiBcIk9ic2lkaWFuIFVzZXJcIixcbiAgdW5mbHVzaGVkSGlnaGxpZ2h0czoge30sXG4gIHVuZmx1c2hlZERlbGV0aW9uczoge30sXG59O1xuXG5mdW5jdGlvbiBoZXhUb1JnYkFycmF5KGhleDogc3RyaW5nKTogW251bWJlciwgbnVtYmVyLCBudW1iZXJdIHtcbiAgY29uc3QgcmVzdWx0ID0gL14jPyhbYS1mXFxkXXsyfSkoW2EtZlxcZF17Mn0pKFthLWZcXGRdezJ9KSQvaS5leGVjKGhleCk7XG4gIHJldHVybiByZXN1bHRcbiAgICA/IFtcbiAgICAgICAgcGFyc2VJbnQocmVzdWx0WzFdIGFzIHN0cmluZywgMTYpIC8gMjU1LFxuICAgICAgICBwYXJzZUludChyZXN1bHRbMl0gYXMgc3RyaW5nLCAxNikgLyAyNTUsXG4gICAgICAgIHBhcnNlSW50KHJlc3VsdFszXSBhcyBzdHJpbmcsIDE2KSAvIDI1NSxcbiAgICAgIF1cbiAgICA6IFsxLCAxLCAwXTtcbn1cblxuZXhwb3J0IGRlZmF1bHQgY2xhc3MgUGRmSGlnaGxpZ2h0ZXJCaXNod2FhUGx1Z2luIGV4dGVuZHMgUGx1Z2luIHtcbiAgc2V0dGluZ3M6IFBkZkhpZ2hsaWdodGVyU2V0dGluZ3M7XG4gIHNlbGVjdGlvbkV4dHJhY3RvcjogU2VsZWN0aW9uRXh0cmFjdG9yO1xuICBoaWdobGlnaHRTdG9yZTogSGlnaGxpZ2h0SnNvblN0b3JlO1xuICBwZGZBbm5vdGF0b3I6IFBkZkFubm90YXRvcjtcblxuICBwZW5kaW5nSGlnaGxpZ2h0czogTWFwPHN0cmluZywgUGRmSGlnaGxpZ2h0UGF5bG9hZFtdPiA9IG5ldyBNYXAoKTtcbiAgcGVuZGluZ0RlbGV0aW9uczogTWFwPHN0cmluZywgc3RyaW5nW10+ID0gbmV3IE1hcCgpO1xuXG4gIC8vIENvbmN1cnJlbmN5IGd1YXJkXG4gIHByaXZhdGUgX2lzRmx1c2hpbmcgPSBmYWxzZTtcbiAgcHJpdmF0ZSBfZmx1c2hQZW5kaW5nID0gZmFsc2U7XG5cbiAgcHVibGljIF9lbmNyeXB0ZWRGaWxlczogU2V0PHN0cmluZz4gPSBuZXcgU2V0KCk7XG5cbiAgYXN5bmMgb25sb2FkKCkge1xuICAgIGF3YWl0IHRoaXMubG9hZFNldHRpbmdzKCk7XG5cbiAgICBpZiAodGhpcy5zZXR0aW5ncy51bmZsdXNoZWRIaWdobGlnaHRzKSB7XG4gICAgICBmb3IgKGNvbnN0IFtrLCB2XSBvZiBPYmplY3QuZW50cmllcyh0aGlzLnNldHRpbmdzLnVuZmx1c2hlZEhpZ2hsaWdodHMpKSB7XG4gICAgICAgIHRoaXMucGVuZGluZ0hpZ2hsaWdodHMuc2V0KGssIHYpO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAodGhpcy5zZXR0aW5ncy51bmZsdXNoZWREZWxldGlvbnMpIHtcbiAgICAgIGZvciAoY29uc3QgW2ssIHZdIG9mIE9iamVjdC5lbnRyaWVzKHRoaXMuc2V0dGluZ3MudW5mbHVzaGVkRGVsZXRpb25zKSkge1xuICAgICAgICB0aGlzLnBlbmRpbmdEZWxldGlvbnMuc2V0KGssIHYpO1xuICAgICAgfVxuICAgIH1cblxuICAgIHRoaXMuaGlnaGxpZ2h0U3RvcmUgPSBuZXcgSGlnaGxpZ2h0SnNvblN0b3JlKHRoaXMpO1xuICAgIHRoaXMuc2VsZWN0aW9uRXh0cmFjdG9yID0gbmV3IFNlbGVjdGlvbkV4dHJhY3RvcigpO1xuICAgIHRoaXMucGRmQW5ub3RhdG9yID0gbmV3IFBkZkFubm90YXRvcih0aGlzLmFwcCk7XG5cbiAgICB0aGlzLmFkZFNldHRpbmdUYWIobmV3IFBkZkhpZ2hsaWdodGVyU2V0dGluZ1RhYih0aGlzLmFwcCwgdGhpcykpO1xuXG4gICAgc2V0VGltZW91dCgoKSA9PiB2b2lkIHRoaXMuZmx1c2hDYWNoZSgpLCAzMDAwKTtcblxuICAgIHRoaXMucmVnaXN0ZXJJbnRlcnZhbChcbiAgICAgIHdpbmRvdy5zZXRJbnRlcnZhbCgoKSA9PiB0aGlzLnJlaW5qZWN0Q3NzT3ZlcmxheXMoKSwgMTUwMCksXG4gICAgKTtcblxuICAgIHRoaXMuYWRkQ29tbWFuZCh7XG4gICAgICBpZDogXCJoaWdobGlnaHQtcGRmLXByaW1hcnlcIixcbiAgICAgIG5hbWU6IFwiSGlnaGxpZ2h0IHNlbGVjdGVkIFBERiB0ZXh0IChwcmltYXJ5KVwiLFxuICAgICAgY2hlY2tDYWxsYmFjazogKGNoZWNraW5nKSA9PiB7XG4gICAgICAgIGlmIChcbiAgICAgICAgICB0aGlzLmFwcC53b3Jrc3BhY2UuZ2V0QWN0aXZlVmlld09mVHlwZShWaWV3KT8uZ2V0Vmlld1R5cGUoKSA9PT0gXCJwZGZcIlxuICAgICAgICApIHtcbiAgICAgICAgICBpZiAoIWNoZWNraW5nKVxuICAgICAgICAgICAgdm9pZCB0aGlzLmV4ZWN1dGVIaWdobGlnaHQodGhpcy5zZXR0aW5ncy5oZXhDb2xvclByaW1hcnkpO1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICB0aGlzLmFkZENvbW1hbmQoe1xuICAgICAgaWQ6IFwiaGlnaGxpZ2h0LXBkZi1zZWNvbmRhcnlcIixcbiAgICAgIG5hbWU6IFwiSGlnaGxpZ2h0IHNlbGVjdGVkIFBERiB0ZXh0IChzZWNvbmRhcnkpXCIsXG4gICAgICBjaGVja0NhbGxiYWNrOiAoY2hlY2tpbmcpID0+IHtcbiAgICAgICAgaWYgKFxuICAgICAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS5nZXRBY3RpdmVWaWV3T2ZUeXBlKFZpZXcpPy5nZXRWaWV3VHlwZSgpID09PSBcInBkZlwiXG4gICAgICAgICkge1xuICAgICAgICAgIGlmICghY2hlY2tpbmcpXG4gICAgICAgICAgICB2b2lkIHRoaXMuZXhlY3V0ZUhpZ2hsaWdodCh0aGlzLnNldHRpbmdzLmhleENvbG9yU2Vjb25kYXJ5KTtcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgdGhpcy5hZGRDb21tYW5kKHtcbiAgICAgIGlkOiBcImhpZ2hsaWdodC1wZGYtdGVydGlhcnlcIixcbiAgICAgIG5hbWU6IFwiSGlnaGxpZ2h0IHNlbGVjdGVkIFBERiB0ZXh0ICh0ZXJ0aWFyeSlcIixcbiAgICAgIGNoZWNrQ2FsbGJhY2s6IChjaGVja2luZykgPT4ge1xuICAgICAgICBpZiAoXG4gICAgICAgICAgdGhpcy5hcHAud29ya3NwYWNlLmdldEFjdGl2ZVZpZXdPZlR5cGUoVmlldyk/LmdldFZpZXdUeXBlKCkgPT09IFwicGRmXCJcbiAgICAgICAgKSB7XG4gICAgICAgICAgaWYgKCFjaGVja2luZylcbiAgICAgICAgICAgIHZvaWQgdGhpcy5leGVjdXRlSGlnaGxpZ2h0KHRoaXMuc2V0dGluZ3MuaGV4Q29sb3JUZXJ0aWFyeSk7XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgfSxcbiAgICB9KTtcblxuICAgIHRoaXMuYWRkQ29tbWFuZCh7XG4gICAgICBpZDogXCJyZW1vdmUtcGRmLWhpZ2hsaWdodFwiLFxuICAgICAgbmFtZTogXCJSZW1vdmUgaGlnaGxpZ2h0IHVuZGVyIHNlbGVjdGlvblwiLFxuICAgICAgY2hlY2tDYWxsYmFjazogKGNoZWNraW5nKSA9PiB7XG4gICAgICAgIGlmIChcbiAgICAgICAgICB0aGlzLmFwcC53b3Jrc3BhY2UuZ2V0QWN0aXZlVmlld09mVHlwZShWaWV3KT8uZ2V0Vmlld1R5cGUoKSA9PT0gXCJwZGZcIlxuICAgICAgICApIHtcbiAgICAgICAgICBpZiAoIWNoZWNraW5nKSB2b2lkIHRoaXMuZXhlY3V0ZVJlbW92ZUhpZ2hsaWdodCgpO1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICB0aGlzLnJlZ2lzdGVyRG9tRXZlbnQoZG9jdW1lbnQsIFwia2V5ZG93blwiLCAoZXZ0OiBLZXlib2FyZEV2ZW50KSA9PiB7XG4gICAgICBpZiAodGhpcy5hcHAud29ya3NwYWNlLmdldEFjdGl2ZVZpZXdPZlR5cGUoVmlldyk/LmdldFZpZXdUeXBlKCkgIT09IFwicGRmXCIpXG4gICAgICAgIHJldHVybjtcblxuICAgICAgY29uc3QgdGFyZ2V0ID0gZXZ0LnRhcmdldCBhcyBIVE1MRWxlbWVudDtcbiAgICAgIGlmIChcbiAgICAgICAgdGFyZ2V0Py50YWdOYW1lID09PSBcIklOUFVUXCIgfHxcbiAgICAgICAgdGFyZ2V0Py50YWdOYW1lID09PSBcIlRFWFRBUkVBXCIgfHxcbiAgICAgICAgdGFyZ2V0Py5pc0NvbnRlbnRFZGl0YWJsZVxuICAgICAgKVxuICAgICAgICByZXR1cm47XG5cbiAgICAgIGNvbnN0IHNlbGVjdGlvbiA9IHdpbmRvdy5nZXRTZWxlY3Rpb24oKTtcbiAgICAgIGNvbnN0IGhhc1NlbGVjdGlvbiA9XG4gICAgICAgIHNlbGVjdGlvbiAmJlxuICAgICAgICAhc2VsZWN0aW9uLmlzQ29sbGFwc2VkICYmXG4gICAgICAgIHNlbGVjdGlvbi50b1N0cmluZygpLnRyaW0oKS5sZW5ndGggPiAwO1xuXG4gICAgICBpZiAoZXZ0LmtleS50b0xvd2VyQ2FzZSgpID09PSBcImhcIiAmJiBoYXNTZWxlY3Rpb24pIHtcbiAgICAgICAgdm9pZCB0aGlzLmV4ZWN1dGVIaWdobGlnaHQodGhpcy5zZXR0aW5ncy5oZXhDb2xvclByaW1hcnkpO1xuICAgICAgICBldnQucHJldmVudERlZmF1bHQoKTtcbiAgICAgIH0gZWxzZSBpZiAoZXZ0LmtleS50b0xvd2VyQ2FzZSgpID09PSBcImdcIiAmJiBoYXNTZWxlY3Rpb24pIHtcbiAgICAgICAgdm9pZCB0aGlzLmV4ZWN1dGVIaWdobGlnaHQodGhpcy5zZXR0aW5ncy5oZXhDb2xvclNlY29uZGFyeSk7XG4gICAgICAgIGV2dC5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgfSBlbHNlIGlmIChldnQua2V5LnRvTG93ZXJDYXNlKCkgPT09IFwialwiICYmIGhhc1NlbGVjdGlvbikge1xuICAgICAgICB2b2lkIHRoaXMuZXhlY3V0ZUhpZ2hsaWdodCh0aGlzLnNldHRpbmdzLmhleENvbG9yVGVydGlhcnkpO1xuICAgICAgICBldnQucHJldmVudERlZmF1bHQoKTtcbiAgICAgIH0gZWxzZSBpZiAoXG4gICAgICAgIChldnQua2V5ID09PSBcIkRlbGV0ZVwiIHx8IGV2dC5rZXkgPT09IFwiQmFja3NwYWNlXCIpICYmXG4gICAgICAgIGhhc1NlbGVjdGlvblxuICAgICAgKSB7XG4gICAgICAgIHZvaWQgdGhpcy5leGVjdXRlUmVtb3ZlSGlnaGxpZ2h0KCk7XG4gICAgICAgIGV2dC5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgdGhpcy5yZWdpc3RlckV2ZW50KFxuICAgICAgdGhpcy5hcHAud29ya3NwYWNlLm9uKFwiYWN0aXZlLWxlYWYtY2hhbmdlXCIsICgpID0+IHRoaXMuZmx1c2hDYWNoZSgpKSxcbiAgICApO1xuICAgIHRoaXMucmVnaXN0ZXJFdmVudCh0aGlzLmFwcC53b3Jrc3BhY2Uub24oXCJxdWl0XCIsICgpID0+IHRoaXMuZmx1c2hDYWNoZSgpKSk7XG5cbiAgICBjb25zb2xlLmRlYnVnKFwiQW5ub3RhdGVQREYgYnkgYmlzaHdhYSBsb2FkZWRcIik7XG4gIH1cblxuICAvLyDilIDilIDilIAgQ29uY3VycmVuY3ktc2FmZSBmbHVzaCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgYXN5bmMgZmx1c2hDYWNoZSgpIHtcbiAgICBpZiAodGhpcy5faXNGbHVzaGluZykge1xuICAgICAgdGhpcy5fZmx1c2hQZW5kaW5nID0gdHJ1ZTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdGhpcy5faXNGbHVzaGluZyA9IHRydWU7XG4gICAgdGhpcy5fZmx1c2hQZW5kaW5nID0gZmFsc2U7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IHRoaXMuX2RvRmx1c2goKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgdGhpcy5faXNGbHVzaGluZyA9IGZhbHNlO1xuICAgICAgaWYgKHRoaXMuX2ZsdXNoUGVuZGluZykge1xuICAgICAgICB0aGlzLl9mbHVzaFBlbmRpbmcgPSBmYWxzZTtcbiAgICAgICAgc2V0VGltZW91dCgoKSA9PiB2b2lkIHRoaXMuZmx1c2hDYWNoZSgpLCA1MCk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBfZG9GbHVzaCgpIHtcbiAgICBpZiAodGhpcy5wZW5kaW5nSGlnaGxpZ2h0cy5zaXplID09PSAwICYmIHRoaXMucGVuZGluZ0RlbGV0aW9ucy5zaXplID09PSAwKVxuICAgICAgcmV0dXJuO1xuXG4gICAgY29uc3QgaGlnaGxpZ2h0c1RvUHJvY2VzcyA9IG5ldyBNYXAodGhpcy5wZW5kaW5nSGlnaGxpZ2h0cyk7XG4gICAgY29uc3QgZGVsZXRpb25zVG9Qcm9jZXNzID0gbmV3IE1hcCh0aGlzLnBlbmRpbmdEZWxldGlvbnMpO1xuXG4gICAgY29uc3QgYWxsUGF0aHMgPSBuZXcgU2V0KFtcbiAgICAgIC4uLmhpZ2hsaWdodHNUb1Byb2Nlc3Mua2V5cygpLFxuICAgICAgLi4uZGVsZXRpb25zVG9Qcm9jZXNzLmtleXMoKSxcbiAgICBdKTtcblxuICAgIGZvciAoY29uc3QgZmlsZVBhdGggb2YgYWxsUGF0aHMpIHtcbiAgICAgIGlmICh0aGlzLl9lbmNyeXB0ZWRGaWxlcy5oYXMoZmlsZVBhdGgpKSBjb250aW51ZTtcblxuICAgICAgY29uc3QgZmlsZSA9IHRoaXMuYXBwLnZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aChmaWxlUGF0aCk7XG4gICAgICBpZiAoIShmaWxlIGluc3RhbmNlb2YgVEZpbGUpKSBjb250aW51ZTtcblxuICAgICAgY29uc3QgaGlnaGxpZ2h0cyA9IGhpZ2hsaWdodHNUb1Byb2Nlc3MuZ2V0KGZpbGVQYXRoKSA/PyBbXTtcbiAgICAgIGNvbnN0IGRlbGV0aW9ucyA9IGRlbGV0aW9uc1RvUHJvY2Vzcy5nZXQoZmlsZVBhdGgpID8/IFtdO1xuICAgICAgaWYgKGhpZ2hsaWdodHMubGVuZ3RoID09PSAwICYmIGRlbGV0aW9ucy5sZW5ndGggPT09IDApIGNvbnRpbnVlO1xuXG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCB0aGlzLnBkZkFubm90YXRvci5hcHBseUJhdGNoVXBkYXRlc1RvUGRmKFxuICAgICAgICAgIGZpbGUsXG4gICAgICAgICAgaGlnaGxpZ2h0cyxcbiAgICAgICAgICBkZWxldGlvbnMsXG4gICAgICAgICk7XG5cbiAgICAgICAgY29uc3QgYnVsa0pzb25FbGVtZW50cyA9IGhpZ2hsaWdodHMubWFwKChwKSA9PiAoe1xuICAgICAgICAgIGlkOiBwLmlkLFxuICAgICAgICAgIHBhZ2U6IHAucGFnZU51bWJlcixcbiAgICAgICAgICByZWN0czogcC5yZWN0cyxcbiAgICAgICAgICB0ZXh0OiBcIkJ1bGsgQW5ub3RhdGVkIERhdGFcIixcbiAgICAgICAgICBjb2xvcjogYHJnYigke01hdGgucm91bmQocC5jb2xvclJnYlswXSAqIDI1NSl9LCAke01hdGgucm91bmQocC5jb2xvclJnYlsxXSAqIDI1NSl9LCAke01hdGgucm91bmQocC5jb2xvclJnYlsyXSAqIDI1NSl9KWAsXG4gICAgICAgICAgb3BhY2l0eTogcC5vcGFjaXR5LFxuICAgICAgICAgIGF1dGhvcjogcC5hdXRob3IsXG4gICAgICAgICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLFxuICAgICAgICB9KSk7XG4gICAgICAgIGNvbnN0IGV4YWN0SWRzVG9EZWxldGUgPSBkZWxldGlvbnMuZmlsdGVyKFxuICAgICAgICAgIChpZCkgPT4gIWlkLnN0YXJ0c1dpdGgoXCJTUEFUSUFMOlwiKSxcbiAgICAgICAgKTtcbiAgICAgICAgYXdhaXQgdGhpcy5oaWdobGlnaHRTdG9yZS5hcHBseUJhdGNoVXBkYXRlc1RvSnNvbihcbiAgICAgICAgICBmaWxlUGF0aCxcbiAgICAgICAgICBidWxrSnNvbkVsZW1lbnRzLFxuICAgICAgICAgIGV4YWN0SWRzVG9EZWxldGUsXG4gICAgICAgICk7XG5cbiAgICAgICAgdGhpcy5wZW5kaW5nSGlnaGxpZ2h0cy5kZWxldGUoZmlsZVBhdGgpO1xuICAgICAgICB0aGlzLnBlbmRpbmdEZWxldGlvbnMuZGVsZXRlKGZpbGVQYXRoKTtcbiAgICAgICAgYXdhaXQgdGhpcy5zeW5jUGVuZGluZ1F1ZXVlVG9EaXNrKCk7XG5cbiAgICAgICAgaWYgKGhpZ2hsaWdodHMubGVuZ3RoID4gMCkge1xuICAgICAgICAgIG5ldyBOb3RpY2UoYOKchSBIaWdobGlnaHRzIHNhdmVkIHRvICR7ZmlsZS5uYW1lfWApO1xuICAgICAgICB9XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGlmIChlIGluc3RhbmNlb2YgRW5jcnlwdGVkUGRmRXJyb3IpIHtcbiAgICAgICAgICBuZXcgTm90aWNlKFxuICAgICAgICAgICAgYPCflJIgXCIke2ZpbGUubmFtZX1cIiBpcyBwYXNzd29yZC1wcm90ZWN0ZWQuXFxuXFxuQW5ub3RhdGVQREYgY2Fubm90IG1vZGlmeSBlbmNyeXB0ZWQgUERGcy4gSGlnaGxpZ2h0cyBoYXZlIGJlZW4gZGlzY2FyZGVkLmAsXG4gICAgICAgICAgICA4MDAwLFxuICAgICAgICAgICk7XG4gICAgICAgICAgLy8gQ2xlYXIgcXVldWUgc28gd2UgbmV2ZXIgcmV0cnkgdGhpcyBmaWxlXG4gICAgICAgICAgdGhpcy5wZW5kaW5nSGlnaGxpZ2h0cy5kZWxldGUoZmlsZVBhdGgpO1xuICAgICAgICAgIHRoaXMucGVuZGluZ0RlbGV0aW9ucy5kZWxldGUoZmlsZVBhdGgpO1xuICAgICAgICAgIHRoaXMuX2VuY3J5cHRlZEZpbGVzLmFkZChmaWxlUGF0aCk7XG4gICAgICAgICAgYXdhaXQgdGhpcy5zeW5jUGVuZGluZ1F1ZXVlVG9EaXNrKCk7XG4gICAgICAgIH0gZWxzZSBpZiAoZSBpbnN0YW5jZW9mIExvY2tlZFBkZkVycm9yKSB7XG4gICAgICAgICAgbmV3IE5vdGljZShcbiAgICAgICAgICAgIGDinYwgXCIke2ZpbGUubmFtZX1cIiBpcyBvcGVuIGluIGFub3RoZXIgYXBwLlxcblxcbkNsb3NlIGl0IHRoZXJlIGZpcnN0LCB0aGVuIHN3aXRjaCB0YWJzIHRvIHNhdmUgeW91ciBoaWdobGlnaHRzLmAsXG4gICAgICAgICAgICA2MDAwLFxuICAgICAgICAgICk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgLy8g4pSA4pSAIFVua25vd24gZXJyb3Ig4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gICAgICAgICAgbmV3IE5vdGljZShcbiAgICAgICAgICAgIGDimqDvuI8gRmFpbGVkIHRvIHNhdmUgaGlnaGxpZ2h0cyB0byBcIiR7ZmlsZS5uYW1lfVwiLlxcblxcbkNoZWNrIHRoZSBkZXZlbG9wZXIgY29uc29sZSBmb3IgZGV0YWlscy5gLFxuICAgICAgICAgICAgNjAwMCxcbiAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc29sZS5lcnJvcihcIltBbm5vdGF0ZVBERl0gRmx1c2ggZXJyb3I6XCIsIGUpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGFzeW5jIHN5bmNQZW5kaW5nUXVldWVUb0Rpc2soKSB7XG4gICAgdGhpcy5zZXR0aW5ncy51bmZsdXNoZWRIaWdobGlnaHRzID0gT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgICAgdGhpcy5wZW5kaW5nSGlnaGxpZ2h0cyxcbiAgICApO1xuICAgIHRoaXMuc2V0dGluZ3MudW5mbHVzaGVkRGVsZXRpb25zID0gT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgICAgdGhpcy5wZW5kaW5nRGVsZXRpb25zLFxuICAgICk7XG4gICAgYXdhaXQgdGhpcy5zYXZlU2V0dGluZ3MoKTtcbiAgfVxuXG4gIGFzeW5jIGV4ZWN1dGVIaWdobGlnaHQoY29sb3JIZXg6IHN0cmluZykge1xuICAgIGNvbnN0IGFjdGl2ZUZpbGUgPSB0aGlzLmFwcC53b3Jrc3BhY2UuZ2V0QWN0aXZlRmlsZSgpO1xuICAgIGlmICghYWN0aXZlRmlsZSB8fCBhY3RpdmVGaWxlLmV4dGVuc2lvbiAhPT0gXCJwZGZcIikgcmV0dXJuO1xuXG4gICAgaWYgKHRoaXMuX2VuY3J5cHRlZEZpbGVzLmhhcyhhY3RpdmVGaWxlLnBhdGgpKSB7XG4gICAgICBuZXcgTm90aWNlKFxuICAgICAgICBg8J+UkiBcIiR7YWN0aXZlRmlsZS5uYW1lfVwiIGlzIHBhc3N3b3JkLXByb3RlY3RlZCBhbmQgY2Fubm90IGJlIGFubm90YXRlZC5gLFxuICAgICAgKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCBzZWxlY3Rpb25EYXRhID0gdGhpcy5zZWxlY3Rpb25FeHRyYWN0b3IuZ2V0QWN0aXZlU2VsZWN0aW9uKCk7XG4gICAgaWYgKCFzZWxlY3Rpb25EYXRhIHx8IHNlbGVjdGlvbkRhdGEucmVjdHMubGVuZ3RoID09PSAwKSB7XG4gICAgICBuZXcgTm90aWNlKFwiTm8gdGV4dCBzZWxlY3RlZCB0byBoaWdobGlnaHRcIik7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3Qgb3BhY2l0eUZsb2F0ID0gdGhpcy5zZXR0aW5ncy5vcGFjaXR5IC8gMTAwO1xuICAgIGNvbnN0IGNvbG9yQXJyYXkgPSBoZXhUb1JnYkFycmF5KGNvbG9ySGV4KTtcbiAgICBjb25zdCBoaWdobGlnaHRJZCA9IHdpbmRvdy5jcnlwdG8ucmFuZG9tVVVJRCgpO1xuXG4gICAgdGhpcy5kcmF3VGVtcG9yYXJ5Q3NzT3ZlcmxheShcbiAgICAgIHNlbGVjdGlvbkRhdGEucGFnZU51bWJlcixcbiAgICAgIHNlbGVjdGlvbkRhdGEucmVjdHMsXG4gICAgICBjb2xvckhleCxcbiAgICAgIG9wYWNpdHlGbG9hdCxcbiAgICApO1xuXG4gICAgY29uc3QgcGF5bG9hZDogUGRmSGlnaGxpZ2h0UGF5bG9hZCA9IHtcbiAgICAgIHBhZ2VOdW1iZXI6IHNlbGVjdGlvbkRhdGEucGFnZU51bWJlcixcbiAgICAgIHJlY3RzOiBzZWxlY3Rpb25EYXRhLnJlY3RzLFxuICAgICAgY29sb3JSZ2I6IGNvbG9yQXJyYXksXG4gICAgICBvcGFjaXR5OiBvcGFjaXR5RmxvYXQsXG4gICAgICBhdXRob3I6IHRoaXMuc2V0dGluZ3MuYXV0aG9yLFxuICAgICAgaWQ6IGhpZ2hsaWdodElkLFxuICAgIH07XG5cbiAgICBjb25zdCBleGlzdGluZyA9IHRoaXMucGVuZGluZ0hpZ2hsaWdodHMuZ2V0KGFjdGl2ZUZpbGUucGF0aCkgPz8gW107XG4gICAgZXhpc3RpbmcucHVzaChwYXlsb2FkKTtcbiAgICB0aGlzLnBlbmRpbmdIaWdobGlnaHRzLnNldChhY3RpdmVGaWxlLnBhdGgsIGV4aXN0aW5nKTtcbiAgICBhd2FpdCB0aGlzLnN5bmNQZW5kaW5nUXVldWVUb0Rpc2soKTtcbiAgICB3aW5kb3cuZ2V0U2VsZWN0aW9uKCk/LmVtcHR5KCk7XG4gIH1cblxuICBhc3luYyBleGVjdXRlUmVtb3ZlSGlnaGxpZ2h0KCkge1xuICAgIGNvbnN0IGFjdGl2ZUZpbGUgPSB0aGlzLmFwcC53b3Jrc3BhY2UuZ2V0QWN0aXZlRmlsZSgpO1xuICAgIGlmICghYWN0aXZlRmlsZSB8fCBhY3RpdmVGaWxlLmV4dGVuc2lvbiAhPT0gXCJwZGZcIikgcmV0dXJuO1xuXG4gICAgaWYgKHRoaXMuX2VuY3J5cHRlZEZpbGVzLmhhcyhhY3RpdmVGaWxlLnBhdGgpKSB7XG4gICAgICBuZXcgTm90aWNlKFxuICAgICAgICBg8J+UkiBcIiR7YWN0aXZlRmlsZS5uYW1lfVwiIGlzIHBhc3N3b3JkLXByb3RlY3RlZCBhbmQgY2Fubm90IGJlIG1vZGlmaWVkLmAsXG4gICAgICApO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IHNlbGVjdGlvbkRhdGEgPSB0aGlzLnNlbGVjdGlvbkV4dHJhY3Rvci5nZXRBY3RpdmVTZWxlY3Rpb24oKTtcbiAgICBpZiAoIXNlbGVjdGlvbkRhdGEgfHwgc2VsZWN0aW9uRGF0YS5yZWN0cy5sZW5ndGggPT09IDApIHJldHVybjtcbiAgICBjb25zdCBjdXJzb3JSZWN0ID0gc2VsZWN0aW9uRGF0YS5yZWN0c1swXTtcbiAgICBpZiAoIWN1cnNvclJlY3QpIHJldHVybjtcblxuICAgIHdpbmRvdy5nZXRTZWxlY3Rpb24oKT8uZW1wdHkoKTtcblxuICAgIC8vIFN0ZXAgMTogcGVuZGluZyBxdWV1ZVxuICAgIGNvbnN0IHFMaXN0ID0gdGhpcy5wZW5kaW5nSGlnaGxpZ2h0cy5nZXQoYWN0aXZlRmlsZS5wYXRoKTtcbiAgICBpZiAocUxpc3QgJiYgcUxpc3QubGVuZ3RoID4gMCkge1xuICAgICAgY29uc3QgYmVmb3JlID0gcUxpc3QubGVuZ3RoO1xuICAgICAgY29uc3QgZmlsdGVyZWQgPSBxTGlzdC5maWx0ZXIoXG4gICAgICAgIChwKSA9PlxuICAgICAgICAgICF0aGlzLmNoZWNrSW50ZXJzZWN0aW9uKFxuICAgICAgICAgICAgcC5wYWdlTnVtYmVyLFxuICAgICAgICAgICAgcC5yZWN0cyxcbiAgICAgICAgICAgIHNlbGVjdGlvbkRhdGEucGFnZU51bWJlcixcbiAgICAgICAgICAgIGN1cnNvclJlY3QsXG4gICAgICAgICAgKSxcbiAgICAgICk7XG4gICAgICBpZiAoZmlsdGVyZWQubGVuZ3RoIDwgYmVmb3JlKSB7XG4gICAgICAgIHRoaXMucGVuZGluZ0hpZ2hsaWdodHMuc2V0KGFjdGl2ZUZpbGUucGF0aCwgZmlsdGVyZWQpO1xuICAgICAgICB0aGlzLnJlbW92ZVRlbXBvcmFyeUNzc092ZXJsYXkoY3Vyc29yUmVjdCwgc2VsZWN0aW9uRGF0YS5wYWdlTnVtYmVyKTtcbiAgICAgICAgYXdhaXQgdGhpcy5zeW5jUGVuZGluZ1F1ZXVlVG9EaXNrKCk7XG4gICAgICAgIG5ldyBOb3RpY2UoYPCfl5HvuI8gUXVldWVkIGhpZ2hsaWdodCBjYW5jZWxsZWRgKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIFN0ZXAgMjogcmVhZCBkaXJlY3RseSBmcm9tIFBERiBiaW5hcnlcbiAgICBsZXQgc2F2ZWRBbm5vdGF0aW9ucztcbiAgICB0cnkge1xuICAgICAgc2F2ZWRBbm5vdGF0aW9ucyA9XG4gICAgICAgIGF3YWl0IHRoaXMucGRmQW5ub3RhdG9yLnJlYWRBbm5vdGF0aW9uc0Zyb21QZGYoYWN0aXZlRmlsZSk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgaWYgKGUgaW5zdGFuY2VvZiBFbmNyeXB0ZWRQZGZFcnJvcikge1xuICAgICAgICB0aGlzLl9lbmNyeXB0ZWRGaWxlcy5hZGQoYWN0aXZlRmlsZS5wYXRoKTtcbiAgICAgICAgbmV3IE5vdGljZShcbiAgICAgICAgICBg8J+UkiBcIiR7YWN0aXZlRmlsZS5uYW1lfVwiIGlzIHBhc3N3b3JkLXByb3RlY3RlZCBhbmQgY2Fubm90IGJlIG1vZGlmaWVkLmAsXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIG5ldyBOb3RpY2UoXG4gICAgICAgIGDimqDvuI8gQ291bGQgbm90IHJlYWQgXCIke2FjdGl2ZUZpbGUubmFtZX1cIi4gQ2hlY2sgdGhlIGNvbnNvbGUgZm9yIGRldGFpbHMuYCxcbiAgICAgICk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKHNhdmVkQW5ub3RhdGlvbnMubGVuZ3RoID09PSAwKSB7XG4gICAgICBuZXcgTm90aWNlKGDimqDvuI8gTm8gc2F2ZWQgaGlnaGxpZ2h0cyBmb3VuZCBpbiB0aGlzIFBERmApO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IG1hcmdpbiA9IDAuMDA1O1xuICAgIGNvbnN0IHRhcmdldCA9IHNhdmVkQW5ub3RhdGlvbnMuZmluZCgoYW5uKSA9PiB7XG4gICAgICBpZiAoYW5uLnBhZ2VOdW1iZXIgIT09IHNlbGVjdGlvbkRhdGEucGFnZU51bWJlcikgcmV0dXJuIGZhbHNlO1xuICAgICAgcmV0dXJuIChcbiAgICAgICAgY3Vyc29yUmVjdC5wTGVmdCA8PSBhbm4ucExlZnQgKyBhbm4ucFdpZHRoICsgbWFyZ2luICYmXG4gICAgICAgIGN1cnNvclJlY3QucExlZnQgKyBjdXJzb3JSZWN0LnBXaWR0aCA+PSBhbm4ucExlZnQgLSBtYXJnaW4gJiZcbiAgICAgICAgY3Vyc29yUmVjdC5wVG9wIDw9IGFubi5wVG9wICsgYW5uLnBIZWlnaHQgKyBtYXJnaW4gJiZcbiAgICAgICAgY3Vyc29yUmVjdC5wVG9wICsgY3Vyc29yUmVjdC5wSGVpZ2h0ID49IGFubi5wVG9wIC0gbWFyZ2luXG4gICAgICApO1xuICAgIH0pO1xuXG4gICAgaWYgKCF0YXJnZXQpIHtcbiAgICAgIG5ldyBOb3RpY2UoYOKaoO+4jyBObyBoaWdobGlnaHQgZm91bmQgYXQgdGhlIHNlbGVjdGVkIHBvc2l0aW9uYCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgZGVsUSA9IHRoaXMucGVuZGluZ0RlbGV0aW9ucy5nZXQoYWN0aXZlRmlsZS5wYXRoKSA/PyBbXTtcbiAgICBpZiAodGFyZ2V0LmlkKSBkZWxRLnB1c2godGFyZ2V0LmlkKTtcbiAgICBkZWxRLnB1c2goXG4gICAgICBgU1BBVElBTDoke3RhcmdldC5wYWdlTnVtYmVyfToke3RhcmdldC5wTGVmdH0sJHt0YXJnZXQucFRvcH0sJHt0YXJnZXQucFdpZHRofSwke3RhcmdldC5wSGVpZ2h0fWAsXG4gICAgKTtcbiAgICB0aGlzLnBlbmRpbmdEZWxldGlvbnMuc2V0KGFjdGl2ZUZpbGUucGF0aCwgZGVsUSk7XG4gICAgYXdhaXQgdGhpcy5zeW5jUGVuZGluZ1F1ZXVlVG9EaXNrKCk7XG4gICAgYXdhaXQgdGhpcy5mbHVzaENhY2hlKCk7XG4gIH1cblxuICAvLyDilIDilIDilIAgQ1NTIG92ZXJsYXkgaGVscGVycyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgZHJhd1RlbXBvcmFyeUNzc092ZXJsYXkoXG4gICAgcGFnZU51bWJlcjogbnVtYmVyLFxuICAgIHJlY3RzOiBSZWN0T3ZlcmxheVtdLFxuICAgIGNvbG9ySGV4OiBzdHJpbmcsXG4gICAgb3BhY2l0eUZsb2F0OiBudW1iZXIsXG4gICkge1xuICAgIGNvbnN0IGNvbnRhaW5lciA9IHRoaXMuYXBwLndvcmtzcGFjZS5nZXRBY3RpdmVWaWV3T2ZUeXBlKFZpZXcpPy5jb250YWluZXJFbDtcbiAgICBpZiAoIWNvbnRhaW5lcikgcmV0dXJuO1xuXG4gICAgY29uc3QgcGFnZURpdiA9IGNvbnRhaW5lci5xdWVyeVNlbGVjdG9yKFxuICAgICAgYC5wYWdlW2RhdGEtcGFnZS1udW1iZXI9XCIke3BhZ2VOdW1iZXJ9XCJdYCxcbiAgICApO1xuICAgIGlmICghcGFnZURpdikgcmV0dXJuO1xuXG4gICAgLy8gQWZ0ZXJcbiAgICBsZXQgdGVtcExheWVyID0gcGFnZURpdi5xdWVyeVNlbGVjdG9yKFwiLnRlbXAtaGlnaGxpZ2h0cy1sYXllclwiKTtcbiAgICBpZiAoIXRlbXBMYXllcikge1xuICAgICAgdGVtcExheWVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgIHRlbXBMYXllci5hZGRDbGFzcyhcInRlbXAtaGlnaGxpZ2h0cy1sYXllclwiKTtcbiAgICAgIHBhZ2VEaXYuYXBwZW5kQ2hpbGQodGVtcExheWVyKTtcbiAgICB9XG5cbiAgICBmb3IgKGNvbnN0IHIgb2YgcmVjdHMpIHtcbiAgICAgIGNvbnN0IGVsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgIGVsLmFkZENsYXNzKFwidGVtcC1oaWdobGlnaHQtcmVjdFwiKTtcbiAgICAgIGVsLnNldENzc1Byb3BzKHtcbiAgICAgICAgbGVmdDogYCR7ci5wTGVmdCAqIDEwMH0lYCxcbiAgICAgICAgdG9wOiBgJHtyLnBUb3AgKiAxMDB9JWAsXG4gICAgICAgIHdpZHRoOiBgJHtyLnBXaWR0aCAqIDEwMH0lYCxcbiAgICAgICAgaGVpZ2h0OiBgJHtyLnBIZWlnaHQgKiAxMDB9JWAsXG4gICAgICAgIFwiYmFja2dyb3VuZC1jb2xvclwiOiBjb2xvckhleCxcbiAgICAgICAgb3BhY2l0eTogb3BhY2l0eUZsb2F0LnRvU3RyaW5nKCksXG4gICAgICB9KTtcbiAgICAgIHRlbXBMYXllci5hcHBlbmRDaGlsZChlbCk7XG4gICAgfVxuICB9XG5cbiAgcmVtb3ZlVGVtcG9yYXJ5Q3NzT3ZlcmxheShjdXJzb3JSZWN0OiBSZWN0T3ZlcmxheSwgcGFnZU51bWJlcjogbnVtYmVyKSB7XG4gICAgY29uc3QgY29udGFpbmVyID0gdGhpcy5hcHAud29ya3NwYWNlLmdldEFjdGl2ZVZpZXdPZlR5cGUoVmlldyk/LmNvbnRhaW5lckVsO1xuICAgIGlmICghY29udGFpbmVyKSByZXR1cm47XG5cbiAgICBjb25zdCBwYWdlRGl2ID0gY29udGFpbmVyLnF1ZXJ5U2VsZWN0b3IoXG4gICAgICBgLnBhZ2VbZGF0YS1wYWdlLW51bWJlcj1cIiR7cGFnZU51bWJlcn1cIl1gLFxuICAgICk7XG4gICAgY29uc3QgdGVtcExheWVyID0gcGFnZURpdj8ucXVlcnlTZWxlY3RvcihcIi50ZW1wLWhpZ2hsaWdodHMtbGF5ZXJcIik7XG4gICAgaWYgKCF0ZW1wTGF5ZXIpIHJldHVybjtcblxuICAgIGZvciAoY29uc3QgZWwgb2YgQXJyYXkuZnJvbSh0ZW1wTGF5ZXIuY2hpbGRyZW4pIGFzIEhUTUxFbGVtZW50W10pIHtcbiAgICAgIGNvbnN0IGwgPSBwYXJzZUZsb2F0KGVsLnN0eWxlLmxlZnQpIC8gMTAwO1xuICAgICAgY29uc3QgdyA9IHBhcnNlRmxvYXQoZWwuc3R5bGUud2lkdGgpIC8gMTAwO1xuICAgICAgY29uc3QgdCA9IHBhcnNlRmxvYXQoZWwuc3R5bGUudG9wKSAvIDEwMDtcbiAgICAgIGNvbnN0IGggPSBwYXJzZUZsb2F0KGVsLnN0eWxlLmhlaWdodCkgLyAxMDA7XG5cbiAgICAgIGlmIChcbiAgICAgICAgY3Vyc29yUmVjdC5wTGVmdCA8PSBsICsgdyAmJlxuICAgICAgICBjdXJzb3JSZWN0LnBMZWZ0ICsgY3Vyc29yUmVjdC5wV2lkdGggPj0gbCAmJlxuICAgICAgICBjdXJzb3JSZWN0LnBUb3AgPD0gdCArIGggJiZcbiAgICAgICAgY3Vyc29yUmVjdC5wVG9wICsgY3Vyc29yUmVjdC5wSGVpZ2h0ID49IHRcbiAgICAgIClcbiAgICAgICAgZWwucmVtb3ZlKCk7XG4gICAgfVxuICB9XG5cbiAgcmVpbmplY3RDc3NPdmVybGF5cygpIHtcbiAgICBjb25zdCBhY3RpdmVGaWxlID0gdGhpcy5hcHAud29ya3NwYWNlLmdldEFjdGl2ZUZpbGUoKTtcbiAgICBpZiAoIWFjdGl2ZUZpbGUgfHwgYWN0aXZlRmlsZS5leHRlbnNpb24gIT09IFwicGRmXCIpIHJldHVybjtcblxuICAgIGNvbnN0IHBlbmRpbmcgPSB0aGlzLnBlbmRpbmdIaWdobGlnaHRzLmdldChhY3RpdmVGaWxlLnBhdGgpO1xuICAgIGlmICghcGVuZGluZyB8fCBwZW5kaW5nLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuXG4gICAgY29uc3QgY29udGFpbmVyID0gdGhpcy5hcHAud29ya3NwYWNlLmdldEFjdGl2ZVZpZXdPZlR5cGUoVmlldyk/LmNvbnRhaW5lckVsO1xuICAgIGlmICghY29udGFpbmVyKSByZXR1cm47XG5cbiAgICBjb25zdCBieVBhZ2UgPSBuZXcgTWFwPG51bWJlciwgUGRmSGlnaGxpZ2h0UGF5bG9hZFtdPigpO1xuICAgIGZvciAoY29uc3QgcCBvZiBwZW5kaW5nKSB7XG4gICAgICBjb25zdCBhcnIgPSBieVBhZ2UuZ2V0KHAucGFnZU51bWJlcikgPz8gW107XG4gICAgICBhcnIucHVzaChwKTtcbiAgICAgIGJ5UGFnZS5zZXQocC5wYWdlTnVtYmVyLCBhcnIpO1xuICAgIH1cblxuICAgIGZvciAoY29uc3QgW3BhZ2VOdW1iZXIsIGhpZ2hsaWdodHNdIG9mIGJ5UGFnZS5lbnRyaWVzKCkpIHtcbiAgICAgIGNvbnN0IHBhZ2VEaXYgPSBjb250YWluZXIucXVlcnlTZWxlY3RvcihcbiAgICAgICAgYC5wYWdlW2RhdGEtcGFnZS1udW1iZXI9XCIke3BhZ2VOdW1iZXJ9XCJdYCxcbiAgICAgICk7XG4gICAgICBpZiAoIXBhZ2VEaXYgfHwgcGFnZURpdi5xdWVyeVNlbGVjdG9yKFwiLnRlbXAtaGlnaGxpZ2h0cy1sYXllclwiKSkgY29udGludWU7XG4gICAgICBmb3IgKGNvbnN0IGhsIG9mIGhpZ2hsaWdodHMpIHtcbiAgICAgICAgY29uc3QgY3NzQ29sb3IgPSBgcmdiKCR7TWF0aC5yb3VuZChobC5jb2xvclJnYlswXSAqIDI1NSl9LCAke01hdGgucm91bmQoaGwuY29sb3JSZ2JbMV0gKiAyNTUpfSwgJHtNYXRoLnJvdW5kKGhsLmNvbG9yUmdiWzJdICogMjU1KX0pYDtcbiAgICAgICAgdGhpcy5kcmF3VGVtcG9yYXJ5Q3NzT3ZlcmxheShcbiAgICAgICAgICBobC5wYWdlTnVtYmVyLFxuICAgICAgICAgIGhsLnJlY3RzLFxuICAgICAgICAgIGNzc0NvbG9yLFxuICAgICAgICAgIGhsLm9wYWNpdHksXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgY2hlY2tJbnRlcnNlY3Rpb24oXG4gICAgaGxQYWdlOiBudW1iZXIsXG4gICAgaGxSZWN0czogUmVjdE92ZXJsYXlbXSxcbiAgICBjdXJzb3JQYWdlOiBudW1iZXIsXG4gICAgY3Vyc29yUmVjdDogUmVjdE92ZXJsYXksXG4gICk6IGJvb2xlYW4ge1xuICAgIGlmIChobFBhZ2UgIT09IGN1cnNvclBhZ2UpIHJldHVybiBmYWxzZTtcbiAgICBjb25zdCBtYXJnaW4gPSAwLjAwNTtcbiAgICBmb3IgKGNvbnN0IHIgb2YgaGxSZWN0cykge1xuICAgICAgaWYgKFxuICAgICAgICBjdXJzb3JSZWN0LnBMZWZ0IDw9IHIucExlZnQgKyByLnBXaWR0aCArIG1hcmdpbiAmJlxuICAgICAgICBjdXJzb3JSZWN0LnBMZWZ0ICsgY3Vyc29yUmVjdC5wV2lkdGggPj0gci5wTGVmdCAtIG1hcmdpbiAmJlxuICAgICAgICBjdXJzb3JSZWN0LnBUb3AgPD0gci5wVG9wICsgci5wSGVpZ2h0ICsgbWFyZ2luICYmXG4gICAgICAgIGN1cnNvclJlY3QucFRvcCArIGN1cnNvclJlY3QucEhlaWdodCA+PSByLnBUb3AgLSBtYXJnaW5cbiAgICAgIClcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIG9udW5sb2FkKCkge1xuICAgIHRoaXMuc3luY1BlbmRpbmdRdWV1ZVRvRGlzaygpLmNhdGNoKGNvbnNvbGUuZXJyb3IpO1xuICAgIHRoaXMuZmx1c2hDYWNoZSgpLmNhdGNoKGNvbnNvbGUuZXJyb3IpO1xuICAgIGNvbnNvbGUuZGVidWcoXCJBbm5vdGF0ZVBERiBieSBiaXNod2FhIHVubG9hZGVkXCIpO1xuICB9XG5cbiAgYXN5bmMgbG9hZFNldHRpbmdzKCkge1xuICAgIHRoaXMuc2V0dGluZ3MgPSBPYmplY3QuYXNzaWduKFxuICAgICAge30sXG4gICAgICBERUZBVUxUX1NFVFRJTkdTLFxuICAgICAgKGF3YWl0IHRoaXMubG9hZERhdGEoKSkgYXMgUGFydGlhbDxQZGZIaWdobGlnaHRlclNldHRpbmdzPixcbiAgICApO1xuICB9XG5cbiAgYXN5bmMgc2F2ZVNldHRpbmdzKCkge1xuICAgIGF3YWl0IHRoaXMuc2F2ZURhdGEodGhpcy5zZXR0aW5ncyk7XG4gIH1cbn1cblxuY2xhc3MgUGRmSGlnaGxpZ2h0ZXJTZXR0aW5nVGFiIGV4dGVuZHMgUGx1Z2luU2V0dGluZ1RhYiB7XG4gIHBsdWdpbjogUGRmSGlnaGxpZ2h0ZXJCaXNod2FhUGx1Z2luO1xuXG4gIGNvbnN0cnVjdG9yKGFwcDogQXBwLCBwbHVnaW46IFBkZkhpZ2hsaWdodGVyQmlzaHdhYVBsdWdpbikge1xuICAgIHN1cGVyKGFwcCwgcGx1Z2luKTtcbiAgICB0aGlzLnBsdWdpbiA9IHBsdWdpbjtcbiAgfVxuXG4gIGRpc3BsYXkoKTogdm9pZCB7XG4gICAgY29uc3QgeyBjb250YWluZXJFbCB9ID0gdGhpcztcbiAgICBjb250YWluZXJFbC5lbXB0eSgpO1xuICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKS5zZXROYW1lKFwiQW5ub3RhdGUgUERGXCIpLnNldEhlYWRpbmcoKTtcblxuICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgLnNldE5hbWUoXCJBdXRob3IgbmFtZVwiKVxuICAgICAgLnNldERlc2MoXCJTdG9yZWQgbmF0aXZlbHkgaW4gdGhlIFBERiBhbm5vdGF0aW9uIG1ldGFkYXRhLlwiKVxuICAgICAgLmFkZFRleHQoKHRleHQpID0+XG4gICAgICAgIHRleHQuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3MuYXV0aG9yKS5vbkNoYW5nZShhc3luYyAodmFsdWUpID0+IHtcbiAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy5hdXRob3IgPSB2YWx1ZTtcbiAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgfSksXG4gICAgICApO1xuXG4gICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG4gICAgICAuc2V0TmFtZShcIlByaW1hcnkgY29sb3IgKGhvdGtleTogaClcIilcbiAgICAgIC5hZGRDb2xvclBpY2tlcigoY29sb3IpID0+XG4gICAgICAgIGNvbG9yXG4gICAgICAgICAgLnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLmhleENvbG9yUHJpbWFyeSlcbiAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XG4gICAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy5oZXhDb2xvclByaW1hcnkgPSB2YWx1ZTtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgIH0pLFxuICAgICAgKTtcblxuICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgLnNldE5hbWUoXCJTZWNvbmRhcnkgY29sb3IgKGhvdGtleTogZylcIilcbiAgICAgIC5hZGRDb2xvclBpY2tlcigoY29sb3IpID0+XG4gICAgICAgIGNvbG9yXG4gICAgICAgICAgLnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLmhleENvbG9yU2Vjb25kYXJ5KVxuICAgICAgICAgIC5vbkNoYW5nZShhc3luYyAodmFsdWUpID0+IHtcbiAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLmhleENvbG9yU2Vjb25kYXJ5ID0gdmFsdWU7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICB9KSxcbiAgICAgICk7XG5cbiAgICBuZXcgU2V0dGluZyhjb250YWluZXJFbClcbiAgICAgIC5zZXROYW1lKFwiVGVydGlhcnkgY29sb3IgKGhvdGtleTogailcIilcbiAgICAgIC5hZGRDb2xvclBpY2tlcigoY29sb3IpID0+XG4gICAgICAgIGNvbG9yXG4gICAgICAgICAgLnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLmhleENvbG9yVGVydGlhcnkpXG4gICAgICAgICAgLm9uQ2hhbmdlKGFzeW5jICh2YWx1ZSkgPT4ge1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3MuaGV4Q29sb3JUZXJ0aWFyeSA9IHZhbHVlO1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgICAgfSksXG4gICAgICApO1xuXG4gICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG4gICAgICAuc2V0TmFtZShcIkhpZ2hsaWdodCBvcGFjaXR5XCIpXG4gICAgICAuc2V0RGVzYyhcIk5hdGl2ZSBQREYgYWxwaGEgb3BhY2l0eSAoMOKAkzEwMCkuXCIpXG4gICAgICAuYWRkU2xpZGVyKChzbGlkZXIpID0+XG4gICAgICAgIHNsaWRlclxuICAgICAgICAgIC5zZXRMaW1pdHMoMCwgMTAwLCAxKVxuICAgICAgICAgIC5zZXRWYWx1ZSh0aGlzLnBsdWdpbi5zZXR0aW5ncy5vcGFjaXR5KVxuICAgICAgICAgIC5zZXREeW5hbWljVG9vbHRpcCgpXG4gICAgICAgICAgLm9uQ2hhbmdlKGFzeW5jICh2YWx1ZSkgPT4ge1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3Mub3BhY2l0eSA9IHZhbHVlO1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgICAgfSksXG4gICAgICApO1xuXG4gICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG4gICAgICAuc2V0TmFtZShcIlJlc2V0IGNhY2hlXCIpXG4gICAgICAuc2V0RGVzYyhcbiAgICAgICAgXCJDbGVhcnMgYWxsIHBlbmRpbmcgcXVldWVzLCB0aGUgSlNPTiBhdWRpdCBsb2csIGFuZCB0aGUgZW5jcnlwdGVkLWZpbGUgYmxvY2tsaXN0LiBcIiArXG4gICAgICAgICAgXCJVc2UgdGhpcyBpZiB5b3UgcmVtb3ZlZCBhIHBhc3N3b3JkIGZyb20gYSBQREYgYW5kIHdhbnQgdG8gYW5ub3RhdGUgaXQgYWdhaW4uXCIsXG4gICAgICApXG4gICAgICAuYWRkQnV0dG9uKChidG4pID0+XG4gICAgICAgIGJ0blxuICAgICAgICAgIC5zZXRCdXR0b25UZXh0KFwiUmVzZXRcIilcbiAgICAgICAgICAuc2V0V2FybmluZygpXG4gICAgICAgICAgLm9uQ2xpY2soYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4ucGVuZGluZ0hpZ2hsaWdodHMuY2xlYXIoKTtcbiAgICAgICAgICAgIHRoaXMucGx1Z2luLnBlbmRpbmdEZWxldGlvbnMuY2xlYXIoKTtcbiAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLnVuZmx1c2hlZEhpZ2hsaWdodHMgPSB7fTtcbiAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLnVuZmx1c2hlZERlbGV0aW9ucyA9IHt9O1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4uX2VuY3J5cHRlZEZpbGVzLmNsZWFyKCk7IC8vIGFsbG93IHJldHJ5aW5nIHByZXZpb3VzbHkgYmxvY2tlZCBmaWxlc1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZURhdGEoeyBmaWxlTWFwOiB7fSB9KTtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgICAgbmV3IE5vdGljZShg4pyFIENhY2hlIHJlc2V0YCk7XG4gICAgICAgICAgfSksXG4gICAgICApO1xuICB9XG59XG5cbi8vIGJpc2h3YWFiYWJ1XG4iXX0=
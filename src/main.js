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
                    new Notice("🗑️ Queued highlight cancelled");
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
                new Notice("⚠️ No saved highlights found in this PDF");
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
                new Notice("⚠️ No highlight found at the selected position");
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
            this.settings = Object.assign({}, DEFAULT_SETTINGS, yield this.loadData());
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
        new Setting(containerEl).setName("AnnotatePDF").setHeading();
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
            new Notice("✅ Cache reset");
        })));
    }
}
// bishwaababu
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1haW4udHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBLE9BQU8sRUFFTCxNQUFNLEVBQ04sZ0JBQWdCLEVBQ2hCLE9BQU8sRUFDUCxNQUFNLEVBQ04sS0FBSyxFQUNMLElBQUksR0FDTCxNQUFNLFVBQVUsQ0FBQztBQUVsQixPQUFPLEVBQ0wsa0JBQWtCLEdBRW5CLE1BQU0sZ0NBQWdDLENBQUM7QUFDeEMsT0FBTyxFQUFFLGtCQUFrQixFQUFFLE1BQU0sOEJBQThCLENBQUM7QUFDbEUsT0FBTyxFQUNMLFlBQVksRUFFWixpQkFBaUIsRUFDakIsY0FBYyxHQUNmLE1BQU0sb0JBQW9CLENBQUM7QUFZNUIsTUFBTSxnQkFBZ0IsR0FBMkI7SUFDL0MsZUFBZSxFQUFFLFNBQVM7SUFDMUIsaUJBQWlCLEVBQUUsU0FBUztJQUM1QixnQkFBZ0IsRUFBRSxTQUFTO0lBQzNCLE9BQU8sRUFBRSxFQUFFO0lBQ1gsTUFBTSxFQUFFLGVBQWU7SUFDdkIsbUJBQW1CLEVBQUUsRUFBRTtJQUN2QixrQkFBa0IsRUFBRSxFQUFFO0NBQ3ZCLENBQUM7QUFFRixTQUFTLGFBQWEsQ0FBQyxHQUFXO0lBQ2hDLE1BQU0sTUFBTSxHQUFHLDJDQUEyQyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUNyRSxPQUFPLE1BQU07UUFDWCxDQUFDLENBQUM7WUFDRSxRQUFRLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBVyxFQUFFLEVBQUUsQ0FBQyxHQUFHLEdBQUc7WUFDdkMsUUFBUSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQVcsRUFBRSxFQUFFLENBQUMsR0FBRyxHQUFHO1lBQ3ZDLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFXLEVBQUUsRUFBRSxDQUFDLEdBQUcsR0FBRztTQUN4QztRQUNILENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUM7QUFDaEIsQ0FBQztB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ICBBcHAsXG4gIFBsdWdpbixcbiAgUGx1Z2luU2V0dGluZ1RhYixcbiAgU2V0dGluZyxcbiAgTm90aWNlLFxuICBURmlsZSxcbiAgVmlldyxcbn0gZnJvbSBcIm9ic2lkaWFuXCI7XG5cbmltcG9ydCB7XG4gIFNlbGVjdGlvbkV4dHJhY3RvcixcbiAgUmVjdE92ZXJsYXksXG59IGZyb20gXCIuL2hpZ2hsaWdodC9TZWxlY3Rpb25FeHRyYWN0b3JcIjtcbmltcG9ydCB7IEhpZ2hsaWdodEpzb25TdG9yZSB9IGZyb20gXCIuL3N0b3JhZ2UvSGlnaGxpZ2h0SnNvblN0b3JlXCI7XG5pbXBvcnQge1xuICBQZGZBbm5vdGF0b3IsXG4gIFBkZkhpZ2hsaWdodFBheWxvYWQsXG4gIEVuY3J5cHRlZFBkZkVycm9yLFxuICBMb2NrZWRQZGZFcnJvcixcbn0gZnJvbSBcIi4vcGRmL1BkZkFubm90YXRvclwiO1xuXG5leHBvcnQgaW50ZXJmYWNlIFBkZkhpZ2hsaWdodGVyU2V0dGluZ3Mge1xuICBoZXhDb2xvclByaW1hcnk6IHN0cmluZztcbiAgaGV4Q29sb3JTZWNvbmRhcnk6IHN0cmluZztcbiAgaGV4Q29sb3JUZXJ0aWFyeTogc3RyaW5nO1xuICBvcGFjaXR5OiBudW1iZXI7XG4gIGF1dGhvcjogc3RyaW5nO1xuICB1bmZsdXNoZWRIaWdobGlnaHRzOiBSZWNvcmQ8c3RyaW5nLCBQZGZIaWdobGlnaHRQYXlsb2FkW10+O1xuICB1bmZsdXNoZWREZWxldGlvbnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZ1tdPjtcbn1cblxuY29uc3QgREVGQVVMVF9TRVRUSU5HUzogUGRmSGlnaGxpZ2h0ZXJTZXR0aW5ncyA9IHtcbiAgaGV4Q29sb3JQcmltYXJ5OiBcIiNmZmZmMDBcIixcbiAgaGV4Q29sb3JTZWNvbmRhcnk6IFwiIzAwZmYwMFwiLFxuICBoZXhDb2xvclRlcnRpYXJ5OiBcIiMwMGZmZmZcIixcbiAgb3BhY2l0eTogNDAsXG4gIGF1dGhvcjogXCJPYnNpZGlhbiBVc2VyXCIsXG4gIHVuZmx1c2hlZEhpZ2hsaWdodHM6IHt9LFxuICB1bmZsdXNoZWREZWxldGlvbnM6IHt9LFxufTtcblxuZnVuY3Rpb24gaGV4VG9SZ2JBcnJheShoZXg6IHN0cmluZyk6IFtudW1iZXIsIG51bWJlciwgbnVtYmVyXSB7XG4gIGNvbnN0IHJlc3VsdCA9IC9eIz8oW2EtZlxcZF17Mn0pKFthLWZcXGRdezJ9KShbYS1mXFxkXXsyfSkkL2kuZXhlYyhoZXgpO1xuICByZXR1cm4gcmVzdWx0XG4gICAgPyBbXG4gICAgICAgIHBhcnNlSW50KHJlc3VsdFsxXSBhcyBzdHJpbmcsIDE2KSAvIDI1NSxcbiAgICAgICAgcGFyc2VJbnQocmVzdWx0WzJdIGFzIHN0cmluZywgMTYpIC8gMjU1LFxuICAgICAgICBwYXJzZUludChyZXN1bHRbM10gYXMgc3RyaW5nLCAxNikgLyAyNTUsXG4gICAgICBdXG4gICAgOiBbMSwgMSwgMF07XG59XG5cbmV4cG9ydCBkZWZhdWx0IGNsYXNzIFBkZkhpZ2hsaWdodGVyQmlzaHdhYVBsdWdpbiBleHRlbmRzIFBsdWdpbiB7XG4gIHNldHRpbmdzOiBQZGZIaWdobGlnaHRlclNldHRpbmdzO1xuICBzZWxlY3Rpb25FeHRyYWN0b3I6IFNlbGVjdGlvbkV4dHJhY3RvcjtcbiAgaGlnaGxpZ2h0U3RvcmU6IEhpZ2hsaWdodEpzb25TdG9yZTtcbiAgcGRmQW5ub3RhdG9yOiBQZGZBbm5vdGF0b3I7XG5cbiAgcGVuZGluZ0hpZ2hsaWdodHM6IE1hcDxzdHJpbmcsIFBkZkhpZ2hsaWdodFBheWxvYWRbXT4gPSBuZXcgTWFwKCk7XG4gIHBlbmRpbmdEZWxldGlvbnM6IE1hcDxzdHJpbmcsIHN0cmluZ1tdPiA9IG5ldyBNYXAoKTtcblxuICAvLyBDb25jdXJyZW5jeSBndWFyZFxuICBwcml2YXRlIF9pc0ZsdXNoaW5nID0gZmFsc2U7XG4gIHByaXZhdGUgX2ZsdXNoUGVuZGluZyA9IGZhbHNlO1xuXG4gIHB1YmxpYyBfZW5jcnlwdGVkRmlsZXM6IFNldDxzdHJpbmc+ID0gbmV3IFNldCgpO1xuXG4gIGFzeW5jIG9ubG9hZCgpIHtcbiAgICBhd2FpdCB0aGlzLmxvYWRTZXR0aW5ncygpO1xuXG4gICAgaWYgKHRoaXMuc2V0dGluZ3MudW5mbHVzaGVkSGlnaGxpZ2h0cykge1xuICAgICAgZm9yIChjb25zdCBbaywgdl0gb2YgT2JqZWN0LmVudHJpZXModGhpcy5zZXR0aW5ncy51bmZsdXNoZWRIaWdobGlnaHRzKSkge1xuICAgICAgICB0aGlzLnBlbmRpbmdIaWdobGlnaHRzLnNldChrLCB2KTtcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKHRoaXMuc2V0dGluZ3MudW5mbHVzaGVkRGVsZXRpb25zKSB7XG4gICAgICBmb3IgKGNvbnN0IFtrLCB2XSBvZiBPYmplY3QuZW50cmllcyh0aGlzLnNldHRpbmdzLnVuZmx1c2hlZERlbGV0aW9ucykpIHtcbiAgICAgICAgdGhpcy5wZW5kaW5nRGVsZXRpb25zLnNldChrLCB2KTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICB0aGlzLmhpZ2hsaWdodFN0b3JlID0gbmV3IEhpZ2hsaWdodEpzb25TdG9yZSh0aGlzKTtcbiAgICB0aGlzLnNlbGVjdGlvbkV4dHJhY3RvciA9IG5ldyBTZWxlY3Rpb25FeHRyYWN0b3IoKTtcbiAgICB0aGlzLnBkZkFubm90YXRvciA9IG5ldyBQZGZBbm5vdGF0b3IodGhpcy5hcHApO1xuXG4gICAgdGhpcy5hZGRTZXR0aW5nVGFiKG5ldyBQZGZIaWdobGlnaHRlclNldHRpbmdUYWIodGhpcy5hcHAsIHRoaXMpKTtcblxuICAgIHNldFRpbWVvdXQoKCkgPT4gdm9pZCB0aGlzLmZsdXNoQ2FjaGUoKSwgMzAwMCk7XG5cbiAgICB0aGlzLnJlZ2lzdGVySW50ZXJ2YWwoXG4gICAgICB3aW5kb3cuc2V0SW50ZXJ2YWwoKCkgPT4gdGhpcy5yZWluamVjdENzc092ZXJsYXlzKCksIDE1MDApLFxuICAgICk7XG5cbiAgICB0aGlzLmFkZENvbW1hbmQoe1xuICAgICAgaWQ6IFwiaGlnaGxpZ2h0LXBkZi1wcmltYXJ5XCIsXG4gICAgICBuYW1lOiBcIkhpZ2hsaWdodCBzZWxlY3RlZCBQREYgdGV4dCAocHJpbWFyeSlcIixcbiAgICAgIGNoZWNrQ2FsbGJhY2s6IChjaGVja2luZykgPT4ge1xuICAgICAgICBpZiAoXG4gICAgICAgICAgdGhpcy5hcHAud29ya3NwYWNlLmdldEFjdGl2ZVZpZXdPZlR5cGUoVmlldyk/LmdldFZpZXdUeXBlKCkgPT09IFwicGRmXCJcbiAgICAgICAgKSB7XG4gICAgICAgICAgaWYgKCFjaGVja2luZylcbiAgICAgICAgICAgIHZvaWQgdGhpcy5leGVjdXRlSGlnaGxpZ2h0KHRoaXMuc2V0dGluZ3MuaGV4Q29sb3JQcmltYXJ5KTtcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgdGhpcy5hZGRDb21tYW5kKHtcbiAgICAgIGlkOiBcImhpZ2hsaWdodC1wZGYtc2Vjb25kYXJ5XCIsXG4gICAgICBuYW1lOiBcIkhpZ2hsaWdodCBzZWxlY3RlZCBQREYgdGV4dCAoc2Vjb25kYXJ5KVwiLFxuICAgICAgY2hlY2tDYWxsYmFjazogKGNoZWNraW5nKSA9PiB7XG4gICAgICAgIGlmIChcbiAgICAgICAgICB0aGlzLmFwcC53b3Jrc3BhY2UuZ2V0QWN0aXZlVmlld09mVHlwZShWaWV3KT8uZ2V0Vmlld1R5cGUoKSA9PT0gXCJwZGZcIlxuICAgICAgICApIHtcbiAgICAgICAgICBpZiAoIWNoZWNraW5nKVxuICAgICAgICAgICAgdm9pZCB0aGlzLmV4ZWN1dGVIaWdobGlnaHQodGhpcy5zZXR0aW5ncy5oZXhDb2xvclNlY29uZGFyeSk7XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgfSxcbiAgICB9KTtcblxuICAgIHRoaXMuYWRkQ29tbWFuZCh7XG4gICAgICBpZDogXCJoaWdobGlnaHQtcGRmLXRlcnRpYXJ5XCIsXG4gICAgICBuYW1lOiBcIkhpZ2hsaWdodCBzZWxlY3RlZCBQREYgdGV4dCAodGVydGlhcnkpXCIsXG4gICAgICBjaGVja0NhbGxiYWNrOiAoY2hlY2tpbmcpID0+IHtcbiAgICAgICAgaWYgKFxuICAgICAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS5nZXRBY3RpdmVWaWV3T2ZUeXBlKFZpZXcpPy5nZXRWaWV3VHlwZSgpID09PSBcInBkZlwiXG4gICAgICAgICkge1xuICAgICAgICAgIGlmICghY2hlY2tpbmcpXG4gICAgICAgICAgICB2b2lkIHRoaXMuZXhlY3V0ZUhpZ2hsaWdodCh0aGlzLnNldHRpbmdzLmhleENvbG9yVGVydGlhcnkpO1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICB0aGlzLmFkZENvbW1hbmQoe1xuICAgICAgaWQ6IFwicmVtb3ZlLXBkZi1oaWdobGlnaHRcIixcbiAgICAgIG5hbWU6IFwiUmVtb3ZlIGhpZ2hsaWdodCB1bmRlciBzZWxlY3Rpb25cIixcbiAgICAgIGNoZWNrQ2FsbGJhY2s6IChjaGVja2luZykgPT4ge1xuICAgICAgICBpZiAoXG4gICAgICAgICAgdGhpcy5hcHAud29ya3NwYWNlLmdldEFjdGl2ZVZpZXdPZlR5cGUoVmlldyk/LmdldFZpZXdUeXBlKCkgPT09IFwicGRmXCJcbiAgICAgICAgKSB7XG4gICAgICAgICAgaWYgKCFjaGVja2luZykgdm9pZCB0aGlzLmV4ZWN1dGVSZW1vdmVIaWdobGlnaHQoKTtcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgdGhpcy5yZWdpc3RlckRvbUV2ZW50KGRvY3VtZW50LCBcImtleWRvd25cIiwgKGV2dDogS2V5Ym9hcmRFdmVudCkgPT4ge1xuICAgICAgaWYgKHRoaXMuYXBwLndvcmtzcGFjZS5nZXRBY3RpdmVWaWV3T2ZUeXBlKFZpZXcpPy5nZXRWaWV3VHlwZSgpICE9PSBcInBkZlwiKVxuICAgICAgICByZXR1cm47XG5cbiAgICAgIGNvbnN0IHRhcmdldCA9IGV2dC50YXJnZXQgYXMgSFRNTEVsZW1lbnQ7XG4gICAgICBpZiAoXG4gICAgICAgIHRhcmdldD8udGFnTmFtZSA9PT0gXCJJTlBVVFwiIHx8XG4gICAgICAgIHRhcmdldD8udGFnTmFtZSA9PT0gXCJURVhUQVJFQVwiIHx8XG4gICAgICAgIHRhcmdldD8uaXNDb250ZW50RWRpdGFibGVcbiAgICAgIClcbiAgICAgICAgcmV0dXJuO1xuXG4gICAgICBjb25zdCBzZWxlY3Rpb24gPSB3aW5kb3cuZ2V0U2VsZWN0aW9uKCk7XG4gICAgICBjb25zdCBoYXNTZWxlY3Rpb24gPVxuICAgICAgICBzZWxlY3Rpb24gJiZcbiAgICAgICAgIXNlbGVjdGlvbi5pc0NvbGxhcHNlZCAmJlxuICAgICAgICBzZWxlY3Rpb24udG9TdHJpbmcoKS50cmltKCkubGVuZ3RoID4gMDtcblxuICAgICAgaWYgKGV2dC5rZXkudG9Mb3dlckNhc2UoKSA9PT0gXCJoXCIgJiYgaGFzU2VsZWN0aW9uKSB7XG4gICAgICAgIHZvaWQgdGhpcy5leGVjdXRlSGlnaGxpZ2h0KHRoaXMuc2V0dGluZ3MuaGV4Q29sb3JQcmltYXJ5KTtcbiAgICAgICAgZXZ0LnByZXZlbnREZWZhdWx0KCk7XG4gICAgICB9IGVsc2UgaWYgKGV2dC5rZXkudG9Mb3dlckNhc2UoKSA9PT0gXCJnXCIgJiYgaGFzU2VsZWN0aW9uKSB7XG4gICAgICAgIHZvaWQgdGhpcy5leGVjdXRlSGlnaGxpZ2h0KHRoaXMuc2V0dGluZ3MuaGV4Q29sb3JTZWNvbmRhcnkpO1xuICAgICAgICBldnQucHJldmVudERlZmF1bHQoKTtcbiAgICAgIH0gZWxzZSBpZiAoZXZ0LmtleS50b0xvd2VyQ2FzZSgpID09PSBcImpcIiAmJiBoYXNTZWxlY3Rpb24pIHtcbiAgICAgICAgdm9pZCB0aGlzLmV4ZWN1dGVIaWdobGlnaHQodGhpcy5zZXR0aW5ncy5oZXhDb2xvclRlcnRpYXJ5KTtcbiAgICAgICAgZXZ0LnByZXZlbnREZWZhdWx0KCk7XG4gICAgICB9IGVsc2UgaWYgKFxuICAgICAgICAoZXZ0LmtleSA9PT0gXCJEZWxldGVcIiB8fCBldnQua2V5ID09PSBcIkJhY2tzcGFjZVwiKSAmJlxuICAgICAgICBoYXNTZWxlY3Rpb25cbiAgICAgICkge1xuICAgICAgICB2b2lkIHRoaXMuZXhlY3V0ZVJlbW92ZUhpZ2hsaWdodCgpO1xuICAgICAgICBldnQucHJldmVudERlZmF1bHQoKTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIHRoaXMucmVnaXN0ZXJFdmVudChcbiAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS5vbihcImFjdGl2ZS1sZWFmLWNoYW5nZVwiLCAoKSA9PiB0aGlzLmZsdXNoQ2FjaGUoKSksXG4gICAgKTtcbiAgICB0aGlzLnJlZ2lzdGVyRXZlbnQodGhpcy5hcHAud29ya3NwYWNlLm9uKFwicXVpdFwiLCAoKSA9PiB0aGlzLmZsdXNoQ2FjaGUoKSkpO1xuXG4gICAgY29uc29sZS5kZWJ1ZyhcIkFubm90YXRlUERGIGJ5IGJpc2h3YWEgbG9hZGVkXCIpO1xuICB9XG5cbiAgLy8g4pSA4pSA4pSAIENvbmN1cnJlbmN5LXNhZmUgZmx1c2gg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIGFzeW5jIGZsdXNoQ2FjaGUoKSB7XG4gICAgaWYgKHRoaXMuX2lzRmx1c2hpbmcpIHtcbiAgICAgIHRoaXMuX2ZsdXNoUGVuZGluZyA9IHRydWU7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHRoaXMuX2lzRmx1c2hpbmcgPSB0cnVlO1xuICAgIHRoaXMuX2ZsdXNoUGVuZGluZyA9IGZhbHNlO1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCB0aGlzLl9kb0ZsdXNoKCk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHRoaXMuX2lzRmx1c2hpbmcgPSBmYWxzZTtcbiAgICAgIGlmICh0aGlzLl9mbHVzaFBlbmRpbmcpIHtcbiAgICAgICAgdGhpcy5fZmx1c2hQZW5kaW5nID0gZmFsc2U7XG4gICAgICAgIHNldFRpbWVvdXQoKCkgPT4gdm9pZCB0aGlzLmZsdXNoQ2FjaGUoKSwgNTApO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgX2RvRmx1c2goKSB7XG4gICAgaWYgKHRoaXMucGVuZGluZ0hpZ2hsaWdodHMuc2l6ZSA9PT0gMCAmJiB0aGlzLnBlbmRpbmdEZWxldGlvbnMuc2l6ZSA9PT0gMClcbiAgICAgIHJldHVybjtcblxuICAgIGNvbnN0IGhpZ2hsaWdodHNUb1Byb2Nlc3MgPSBuZXcgTWFwKHRoaXMucGVuZGluZ0hpZ2hsaWdodHMpO1xuICAgIGNvbnN0IGRlbGV0aW9uc1RvUHJvY2VzcyA9IG5ldyBNYXAodGhpcy5wZW5kaW5nRGVsZXRpb25zKTtcblxuICAgIGNvbnN0IGFsbFBhdGhzID0gbmV3IFNldChbXG4gICAgICAuLi5oaWdobGlnaHRzVG9Qcm9jZXNzLmtleXMoKSxcbiAgICAgIC4uLmRlbGV0aW9uc1RvUHJvY2Vzcy5rZXlzKCksXG4gICAgXSk7XG5cbiAgICBmb3IgKGNvbnN0IGZpbGVQYXRoIG9mIGFsbFBhdGhzKSB7XG4gICAgICBpZiAodGhpcy5fZW5jcnlwdGVkRmlsZXMuaGFzKGZpbGVQYXRoKSkgY29udGludWU7XG5cbiAgICAgIGNvbnN0IGZpbGUgPSB0aGlzLmFwcC52YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgoZmlsZVBhdGgpO1xuICAgICAgaWYgKCEoZmlsZSBpbnN0YW5jZW9mIFRGaWxlKSkgY29udGludWU7XG5cbiAgICAgIGNvbnN0IGhpZ2hsaWdodHMgPSBoaWdobGlnaHRzVG9Qcm9jZXNzLmdldChmaWxlUGF0aCkgPz8gW107XG4gICAgICBjb25zdCBkZWxldGlvbnMgPSBkZWxldGlvbnNUb1Byb2Nlc3MuZ2V0KGZpbGVQYXRoKSA/PyBbXTtcbiAgICAgIGlmIChoaWdobGlnaHRzLmxlbmd0aCA9PT0gMCAmJiBkZWxldGlvbnMubGVuZ3RoID09PSAwKSBjb250aW51ZTtcblxuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgdGhpcy5wZGZBbm5vdGF0b3IuYXBwbHlCYXRjaFVwZGF0ZXNUb1BkZihcbiAgICAgICAgICBmaWxlLFxuICAgICAgICAgIGhpZ2hsaWdodHMsXG4gICAgICAgICAgZGVsZXRpb25zLFxuICAgICAgICApO1xuXG4gICAgICAgIGNvbnN0IGJ1bGtKc29uRWxlbWVudHMgPSBoaWdobGlnaHRzLm1hcCgocCkgPT4gKHtcbiAgICAgICAgICBpZDogcC5pZCxcbiAgICAgICAgICBwYWdlOiBwLnBhZ2VOdW1iZXIsXG4gICAgICAgICAgcmVjdHM6IHAucmVjdHMsXG4gICAgICAgICAgdGV4dDogXCJCdWxrIEFubm90YXRlZCBEYXRhXCIsXG4gICAgICAgICAgY29sb3I6IGByZ2IoJHtNYXRoLnJvdW5kKHAuY29sb3JSZ2JbMF0gKiAyNTUpfSwgJHtNYXRoLnJvdW5kKHAuY29sb3JSZ2JbMV0gKiAyNTUpfSwgJHtNYXRoLnJvdW5kKHAuY29sb3JSZ2JbMl0gKiAyNTUpfSlgLFxuICAgICAgICAgIG9wYWNpdHk6IHAub3BhY2l0eSxcbiAgICAgICAgICBhdXRob3I6IHAuYXV0aG9yLFxuICAgICAgICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcbiAgICAgICAgfSkpO1xuICAgICAgICBjb25zdCBleGFjdElkc1RvRGVsZXRlID0gZGVsZXRpb25zLmZpbHRlcihcbiAgICAgICAgICAoaWQpID0+ICFpZC5zdGFydHNXaXRoKFwiU1BBVElBTDpcIiksXG4gICAgICAgICk7XG4gICAgICAgIGF3YWl0IHRoaXMuaGlnaGxpZ2h0U3RvcmUuYXBwbHlCYXRjaFVwZGF0ZXNUb0pzb24oXG4gICAgICAgICAgZmlsZVBhdGgsXG4gICAgICAgICAgYnVsa0pzb25FbGVtZW50cyxcbiAgICAgICAgICBleGFjdElkc1RvRGVsZXRlLFxuICAgICAgICApO1xuXG4gICAgICAgIHRoaXMucGVuZGluZ0hpZ2hsaWdodHMuZGVsZXRlKGZpbGVQYXRoKTtcbiAgICAgICAgdGhpcy5wZW5kaW5nRGVsZXRpb25zLmRlbGV0ZShmaWxlUGF0aCk7XG4gICAgICAgIGF3YWl0IHRoaXMuc3luY1BlbmRpbmdRdWV1ZVRvRGlzaygpO1xuXG4gICAgICAgIGlmIChoaWdobGlnaHRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICBuZXcgTm90aWNlKGDinIUgSGlnaGxpZ2h0cyBzYXZlZCB0byAke2ZpbGUubmFtZX1gKTtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBpZiAoZSBpbnN0YW5jZW9mIEVuY3J5cHRlZFBkZkVycm9yKSB7XG4gICAgICAgICAgbmV3IE5vdGljZShcbiAgICAgICAgICAgIGDwn5SSIFwiJHtmaWxlLm5hbWV9XCIgaXMgcGFzc3dvcmQtcHJvdGVjdGVkLlxcblxcbkFubm90YXRlUERGIGNhbm5vdCBtb2RpZnkgZW5jcnlwdGVkIFBERnMuIEhpZ2hsaWdodHMgaGF2ZSBiZWVuIGRpc2NhcmRlZC5gLFxuICAgICAgICAgICAgODAwMCxcbiAgICAgICAgICApO1xuICAgICAgICAgIC8vIENsZWFyIHF1ZXVlIHNvIHdlIG5ldmVyIHJldHJ5IHRoaXMgZmlsZVxuICAgICAgICAgIHRoaXMucGVuZGluZ0hpZ2hsaWdodHMuZGVsZXRlKGZpbGVQYXRoKTtcbiAgICAgICAgICB0aGlzLnBlbmRpbmdEZWxldGlvbnMuZGVsZXRlKGZpbGVQYXRoKTtcbiAgICAgICAgICB0aGlzLl9lbmNyeXB0ZWRGaWxlcy5hZGQoZmlsZVBhdGgpO1xuICAgICAgICAgIGF3YWl0IHRoaXMuc3luY1BlbmRpbmdRdWV1ZVRvRGlzaygpO1xuICAgICAgICB9IGVsc2UgaWYgKGUgaW5zdGFuY2VvZiBMb2NrZWRQZGZFcnJvcikge1xuICAgICAgICAgIG5ldyBOb3RpY2UoXG4gICAgICAgICAgICBg4p2MIFwiJHtmaWxlLm5hbWV9XCIgaXMgb3BlbiBpbiBhbm90aGVyIGFwcC5cXG5cXG5DbG9zZSBpdCB0aGVyZSBmaXJzdCwgdGhlbiBzd2l0Y2ggdGFicyB0byBzYXZlIHlvdXIgaGlnaGxpZ2h0cy5gLFxuICAgICAgICAgICAgNjAwMCxcbiAgICAgICAgICApO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIC8vIOKUgOKUgCBVbmtub3duIGVycm9yIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAgICAgICAgIG5ldyBOb3RpY2UoXG4gICAgICAgICAgICBg4pqg77iPIEZhaWxlZCB0byBzYXZlIGhpZ2hsaWdodHMgdG8gXCIke2ZpbGUubmFtZX1cIi5cXG5cXG5DaGVjayB0aGUgZGV2ZWxvcGVyIGNvbnNvbGUgZm9yIGRldGFpbHMuYCxcbiAgICAgICAgICAgIDYwMDAsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnNvbGUuZXJyb3IoXCJbQW5ub3RhdGVQREZdIEZsdXNoIGVycm9yOlwiLCBlKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBhc3luYyBzeW5jUGVuZGluZ1F1ZXVlVG9EaXNrKCkge1xuICAgIHRoaXMuc2V0dGluZ3MudW5mbHVzaGVkSGlnaGxpZ2h0cyA9IE9iamVjdC5mcm9tRW50cmllcyhcbiAgICAgIHRoaXMucGVuZGluZ0hpZ2hsaWdodHMsXG4gICAgKTtcbiAgICB0aGlzLnNldHRpbmdzLnVuZmx1c2hlZERlbGV0aW9ucyA9IE9iamVjdC5mcm9tRW50cmllcyhcbiAgICAgIHRoaXMucGVuZGluZ0RlbGV0aW9ucyxcbiAgICApO1xuICAgIGF3YWl0IHRoaXMuc2F2ZVNldHRpbmdzKCk7XG4gIH1cblxuICBhc3luYyBleGVjdXRlSGlnaGxpZ2h0KGNvbG9ySGV4OiBzdHJpbmcpIHtcbiAgICBjb25zdCBhY3RpdmVGaWxlID0gdGhpcy5hcHAud29ya3NwYWNlLmdldEFjdGl2ZUZpbGUoKTtcbiAgICBpZiAoIWFjdGl2ZUZpbGUgfHwgYWN0aXZlRmlsZS5leHRlbnNpb24gIT09IFwicGRmXCIpIHJldHVybjtcblxuICAgIGlmICh0aGlzLl9lbmNyeXB0ZWRGaWxlcy5oYXMoYWN0aXZlRmlsZS5wYXRoKSkge1xuICAgICAgbmV3IE5vdGljZShcbiAgICAgICAgYPCflJIgXCIke2FjdGl2ZUZpbGUubmFtZX1cIiBpcyBwYXNzd29yZC1wcm90ZWN0ZWQgYW5kIGNhbm5vdCBiZSBhbm5vdGF0ZWQuYCxcbiAgICAgICk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3Qgc2VsZWN0aW9uRGF0YSA9IHRoaXMuc2VsZWN0aW9uRXh0cmFjdG9yLmdldEFjdGl2ZVNlbGVjdGlvbigpO1xuICAgIGlmICghc2VsZWN0aW9uRGF0YSB8fCBzZWxlY3Rpb25EYXRhLnJlY3RzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgbmV3IE5vdGljZShcIk5vIHRleHQgc2VsZWN0ZWQgdG8gaGlnaGxpZ2h0XCIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IG9wYWNpdHlGbG9hdCA9IHRoaXMuc2V0dGluZ3Mub3BhY2l0eSAvIDEwMDtcbiAgICBjb25zdCBjb2xvckFycmF5ID0gaGV4VG9SZ2JBcnJheShjb2xvckhleCk7XG4gICAgY29uc3QgaGlnaGxpZ2h0SWQgPSB3aW5kb3cuY3J5cHRvLnJhbmRvbVVVSUQoKTtcblxuICAgIHRoaXMuZHJhd1RlbXBvcmFyeUNzc092ZXJsYXkoXG4gICAgICBzZWxlY3Rpb25EYXRhLnBhZ2VOdW1iZXIsXG4gICAgICBzZWxlY3Rpb25EYXRhLnJlY3RzLFxuICAgICAgY29sb3JIZXgsXG4gICAgICBvcGFjaXR5RmxvYXQsXG4gICAgKTtcblxuICAgIGNvbnN0IHBheWxvYWQ6IFBkZkhpZ2hsaWdodFBheWxvYWQgPSB7XG4gICAgICBwYWdlTnVtYmVyOiBzZWxlY3Rpb25EYXRhLnBhZ2VOdW1iZXIsXG4gICAgICByZWN0czogc2VsZWN0aW9uRGF0YS5yZWN0cyxcbiAgICAgIGNvbG9yUmdiOiBjb2xvckFycmF5LFxuICAgICAgb3BhY2l0eTogb3BhY2l0eUZsb2F0LFxuICAgICAgYXV0aG9yOiB0aGlzLnNldHRpbmdzLmF1dGhvcixcbiAgICAgIGlkOiBoaWdobGlnaHRJZCxcbiAgICB9O1xuXG4gICAgY29uc3QgZXhpc3RpbmcgPSB0aGlzLnBlbmRpbmdIaWdobGlnaHRzLmdldChhY3RpdmVGaWxlLnBhdGgpID8/IFtdO1xuICAgIGV4aXN0aW5nLnB1c2gocGF5bG9hZCk7XG4gICAgdGhpcy5wZW5kaW5nSGlnaGxpZ2h0cy5zZXQoYWN0aXZlRmlsZS5wYXRoLCBleGlzdGluZyk7XG4gICAgYXdhaXQgdGhpcy5zeW5jUGVuZGluZ1F1ZXVlVG9EaXNrKCk7XG4gICAgd2luZG93LmdldFNlbGVjdGlvbigpPy5lbXB0eSgpO1xuICB9XG5cbiAgYXN5bmMgZXhlY3V0ZVJlbW92ZUhpZ2hsaWdodCgpIHtcbiAgICBjb25zdCBhY3RpdmVGaWxlID0gdGhpcy5hcHAud29ya3NwYWNlLmdldEFjdGl2ZUZpbGUoKTtcbiAgICBpZiAoIWFjdGl2ZUZpbGUgfHwgYWN0aXZlRmlsZS5leHRlbnNpb24gIT09IFwicGRmXCIpIHJldHVybjtcblxuICAgIGlmICh0aGlzLl9lbmNyeXB0ZWRGaWxlcy5oYXMoYWN0aXZlRmlsZS5wYXRoKSkge1xuICAgICAgbmV3IE5vdGljZShcbiAgICAgICAgYPCflJIgXCIke2FjdGl2ZUZpbGUubmFtZX1cIiBpcyBwYXNzd29yZC1wcm90ZWN0ZWQgYW5kIGNhbm5vdCBiZSBtb2RpZmllZC5gLFxuICAgICAgKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCBzZWxlY3Rpb25EYXRhID0gdGhpcy5zZWxlY3Rpb25FeHRyYWN0b3IuZ2V0QWN0aXZlU2VsZWN0aW9uKCk7XG4gICAgaWYgKCFzZWxlY3Rpb25EYXRhIHx8IHNlbGVjdGlvbkRhdGEucmVjdHMubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgY29uc3QgY3Vyc29yUmVjdCA9IHNlbGVjdGlvbkRhdGEucmVjdHNbMF07XG4gICAgaWYgKCFjdXJzb3JSZWN0KSByZXR1cm47XG5cbiAgICB3aW5kb3cuZ2V0U2VsZWN0aW9uKCk/LmVtcHR5KCk7XG5cbiAgICAvLyBTdGVwIDE6IHBlbmRpbmcgcXVldWVcbiAgICBjb25zdCBxTGlzdCA9IHRoaXMucGVuZGluZ0hpZ2hsaWdodHMuZ2V0KGFjdGl2ZUZpbGUucGF0aCk7XG4gICAgaWYgKHFMaXN0ICYmIHFMaXN0Lmxlbmd0aCA+IDApIHtcbiAgICAgIGNvbnN0IGJlZm9yZSA9IHFMaXN0Lmxlbmd0aDtcbiAgICAgIGNvbnN0IGZpbHRlcmVkID0gcUxpc3QuZmlsdGVyKFxuICAgICAgICAocCkgPT5cbiAgICAgICAgICAhdGhpcy5jaGVja0ludGVyc2VjdGlvbihcbiAgICAgICAgICAgIHAucGFnZU51bWJlcixcbiAgICAgICAgICAgIHAucmVjdHMsXG4gICAgICAgICAgICBzZWxlY3Rpb25EYXRhLnBhZ2VOdW1iZXIsXG4gICAgICAgICAgICBjdXJzb3JSZWN0LFxuICAgICAgICAgICksXG4gICAgICApO1xuICAgICAgaWYgKGZpbHRlcmVkLmxlbmd0aCA8IGJlZm9yZSkge1xuICAgICAgICB0aGlzLnBlbmRpbmdIaWdobGlnaHRzLnNldChhY3RpdmVGaWxlLnBhdGgsIGZpbHRlcmVkKTtcbiAgICAgICAgdGhpcy5yZW1vdmVUZW1wb3JhcnlDc3NPdmVybGF5KGN1cnNvclJlY3QsIHNlbGVjdGlvbkRhdGEucGFnZU51bWJlcik7XG4gICAgICAgIGF3YWl0IHRoaXMuc3luY1BlbmRpbmdRdWV1ZVRvRGlzaygpO1xuICAgICAgICBuZXcgTm90aWNlKFwi8J+Xke+4jyBRdWV1ZWQgaGlnaGxpZ2h0IGNhbmNlbGxlZFwiKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIFN0ZXAgMjogcmVhZCBkaXJlY3RseSBmcm9tIFBERiBiaW5hcnlcbiAgICBsZXQgc2F2ZWRBbm5vdGF0aW9ucztcbiAgICB0cnkge1xuICAgICAgc2F2ZWRBbm5vdGF0aW9ucyA9XG4gICAgICAgIGF3YWl0IHRoaXMucGRmQW5ub3RhdG9yLnJlYWRBbm5vdGF0aW9uc0Zyb21QZGYoYWN0aXZlRmlsZSk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgaWYgKGUgaW5zdGFuY2VvZiBFbmNyeXB0ZWRQZGZFcnJvcikge1xuICAgICAgICB0aGlzLl9lbmNyeXB0ZWRGaWxlcy5hZGQoYWN0aXZlRmlsZS5wYXRoKTtcbiAgICAgICAgbmV3IE5vdGljZShcbiAgICAgICAgICBg8J+UkiBcIiR7YWN0aXZlRmlsZS5uYW1lfVwiIGlzIHBhc3N3b3JkLXByb3RlY3RlZCBhbmQgY2Fubm90IGJlIG1vZGlmaWVkLmAsXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIG5ldyBOb3RpY2UoXG4gICAgICAgIGDimqDvuI8gQ291bGQgbm90IHJlYWQgXCIke2FjdGl2ZUZpbGUubmFtZX1cIi4gQ2hlY2sgdGhlIGNvbnNvbGUgZm9yIGRldGFpbHMuYCxcbiAgICAgICk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKHNhdmVkQW5ub3RhdGlvbnMubGVuZ3RoID09PSAwKSB7XG4gICAgICBuZXcgTm90aWNlKFwi4pqg77iPIE5vIHNhdmVkIGhpZ2hsaWdodHMgZm91bmQgaW4gdGhpcyBQREZcIik7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgbWFyZ2luID0gMC4wMDU7XG4gICAgY29uc3QgdGFyZ2V0ID0gc2F2ZWRBbm5vdGF0aW9ucy5maW5kKChhbm4pID0+IHtcbiAgICAgIGlmIChhbm4ucGFnZU51bWJlciAhPT0gc2VsZWN0aW9uRGF0YS5wYWdlTnVtYmVyKSByZXR1cm4gZmFsc2U7XG4gICAgICByZXR1cm4gKFxuICAgICAgICBjdXJzb3JSZWN0LnBMZWZ0IDw9IGFubi5wTGVmdCArIGFubi5wV2lkdGggKyBtYXJnaW4gJiZcbiAgICAgICAgY3Vyc29yUmVjdC5wTGVmdCArIGN1cnNvclJlY3QucFdpZHRoID49IGFubi5wTGVmdCAtIG1hcmdpbiAmJlxuICAgICAgICBjdXJzb3JSZWN0LnBUb3AgPD0gYW5uLnBUb3AgKyBhbm4ucEhlaWdodCArIG1hcmdpbiAmJlxuICAgICAgICBjdXJzb3JSZWN0LnBUb3AgKyBjdXJzb3JSZWN0LnBIZWlnaHQgPj0gYW5uLnBUb3AgLSBtYXJnaW5cbiAgICAgICk7XG4gICAgfSk7XG5cbiAgICBpZiAoIXRhcmdldCkge1xuICAgICAgbmV3IE5vdGljZShcIuKaoO+4jyBObyBoaWdobGlnaHQgZm91bmQgYXQgdGhlIHNlbGVjdGVkIHBvc2l0aW9uXCIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IGRlbFEgPSB0aGlzLnBlbmRpbmdEZWxldGlvbnMuZ2V0KGFjdGl2ZUZpbGUucGF0aCkgPz8gW107XG4gICAgaWYgKHRhcmdldC5pZCkgZGVsUS5wdXNoKHRhcmdldC5pZCk7XG4gICAgZGVsUS5wdXNoKFxuICAgICAgYFNQQVRJQUw6JHt0YXJnZXQucGFnZU51bWJlcn06JHt0YXJnZXQucExlZnR9LCR7dGFyZ2V0LnBUb3B9LCR7dGFyZ2V0LnBXaWR0aH0sJHt0YXJnZXQucEhlaWdodH1gLFxuICAgICk7XG4gICAgdGhpcy5wZW5kaW5nRGVsZXRpb25zLnNldChhY3RpdmVGaWxlLnBhdGgsIGRlbFEpO1xuICAgIGF3YWl0IHRoaXMuc3luY1BlbmRpbmdRdWV1ZVRvRGlzaygpO1xuICAgIGF3YWl0IHRoaXMuZmx1c2hDYWNoZSgpO1xuICB9XG5cbiAgLy8g4pSA4pSA4pSAIENTUyBvdmVybGF5IGhlbHBlcnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIGRyYXdUZW1wb3JhcnlDc3NPdmVybGF5KFxuICAgIHBhZ2VOdW1iZXI6IG51bWJlcixcbiAgICByZWN0czogUmVjdE92ZXJsYXlbXSxcbiAgICBjb2xvckhleDogc3RyaW5nLFxuICAgIG9wYWNpdHlGbG9hdDogbnVtYmVyLFxuICApIHtcbiAgICBjb25zdCBjb250YWluZXIgPSB0aGlzLmFwcC53b3Jrc3BhY2UuZ2V0QWN0aXZlVmlld09mVHlwZShWaWV3KT8uY29udGFpbmVyRWw7XG4gICAgaWYgKCFjb250YWluZXIpIHJldHVybjtcblxuICAgIGNvbnN0IHBhZ2VEaXYgPSBjb250YWluZXIucXVlcnlTZWxlY3RvcihcbiAgICAgIGAucGFnZVtkYXRhLXBhZ2UtbnVtYmVyPVwiJHtwYWdlTnVtYmVyfVwiXWAsXG4gICAgKTtcbiAgICBpZiAoIXBhZ2VEaXYpIHJldHVybjtcblxuICAgIC8vIEFmdGVyXG4gICAgbGV0IHRlbXBMYXllciA9IHBhZ2VEaXYucXVlcnlTZWxlY3RvcihcIi50ZW1wLWhpZ2hsaWdodHMtbGF5ZXJcIik7XG4gICAgaWYgKCF0ZW1wTGF5ZXIpIHtcbiAgICAgIHRlbXBMYXllciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICB0ZW1wTGF5ZXIuYWRkQ2xhc3MoXCJ0ZW1wLWhpZ2hsaWdodHMtbGF5ZXJcIik7XG4gICAgICBwYWdlRGl2LmFwcGVuZENoaWxkKHRlbXBMYXllcik7XG4gICAgfVxuXG4gICAgZm9yIChjb25zdCByIG9mIHJlY3RzKSB7XG4gICAgICBjb25zdCBlbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICBlbC5hZGRDbGFzcyhcInRlbXAtaGlnaGxpZ2h0LXJlY3RcIik7XG4gICAgICBlbC5zZXRDc3NQcm9wcyh7XG4gICAgICAgIGxlZnQ6IGAke3IucExlZnQgKiAxMDB9JWAsXG4gICAgICAgIHRvcDogYCR7ci5wVG9wICogMTAwfSVgLFxuICAgICAgICB3aWR0aDogYCR7ci5wV2lkdGggKiAxMDB9JWAsXG4gICAgICAgIGhlaWdodDogYCR7ci5wSGVpZ2h0ICogMTAwfSVgLFxuICAgICAgICBcImJhY2tncm91bmQtY29sb3JcIjogY29sb3JIZXgsXG4gICAgICAgIG9wYWNpdHk6IG9wYWNpdHlGbG9hdC50b1N0cmluZygpLFxuICAgICAgfSk7XG4gICAgICB0ZW1wTGF5ZXIuYXBwZW5kQ2hpbGQoZWwpO1xuICAgIH1cbiAgfVxuXG4gIHJlbW92ZVRlbXBvcmFyeUNzc092ZXJsYXkoY3Vyc29yUmVjdDogUmVjdE92ZXJsYXksIHBhZ2VOdW1iZXI6IG51bWJlcikge1xuICAgIGNvbnN0IGNvbnRhaW5lciA9IHRoaXMuYXBwLndvcmtzcGFjZS5nZXRBY3RpdmVWaWV3T2ZUeXBlKFZpZXcpPy5jb250YWluZXJFbDtcbiAgICBpZiAoIWNvbnRhaW5lcikgcmV0dXJuO1xuXG4gICAgY29uc3QgcGFnZURpdiA9IGNvbnRhaW5lci5xdWVyeVNlbGVjdG9yKFxuICAgICAgYC5wYWdlW2RhdGEtcGFnZS1udW1iZXI9XCIke3BhZ2VOdW1iZXJ9XCJdYCxcbiAgICApO1xuICAgIGNvbnN0IHRlbXBMYXllciA9IHBhZ2VEaXY/LnF1ZXJ5U2VsZWN0b3IoXCIudGVtcC1oaWdobGlnaHRzLWxheWVyXCIpO1xuICAgIGlmICghdGVtcExheWVyKSByZXR1cm47XG5cbiAgICBmb3IgKGNvbnN0IGVsIG9mIEFycmF5LmZyb20odGVtcExheWVyLmNoaWxkcmVuKSBhcyBIVE1MRWxlbWVudFtdKSB7XG4gICAgICBjb25zdCBsID0gcGFyc2VGbG9hdChlbC5zdHlsZS5sZWZ0KSAvIDEwMDtcbiAgICAgIGNvbnN0IHcgPSBwYXJzZUZsb2F0KGVsLnN0eWxlLndpZHRoKSAvIDEwMDtcbiAgICAgIGNvbnN0IHQgPSBwYXJzZUZsb2F0KGVsLnN0eWxlLnRvcCkgLyAxMDA7XG4gICAgICBjb25zdCBoID0gcGFyc2VGbG9hdChlbC5zdHlsZS5oZWlnaHQpIC8gMTAwO1xuXG4gICAgICBpZiAoXG4gICAgICAgIGN1cnNvclJlY3QucExlZnQgPD0gbCArIHcgJiZcbiAgICAgICAgY3Vyc29yUmVjdC5wTGVmdCArIGN1cnNvclJlY3QucFdpZHRoID49IGwgJiZcbiAgICAgICAgY3Vyc29yUmVjdC5wVG9wIDw9IHQgKyBoICYmXG4gICAgICAgIGN1cnNvclJlY3QucFRvcCArIGN1cnNvclJlY3QucEhlaWdodCA+PSB0XG4gICAgICApXG4gICAgICAgIGVsLnJlbW92ZSgpO1xuICAgIH1cbiAgfVxuXG4gIHJlaW5qZWN0Q3NzT3ZlcmxheXMoKSB7XG4gICAgY29uc3QgYWN0aXZlRmlsZSA9IHRoaXMuYXBwLndvcmtzcGFjZS5nZXRBY3RpdmVGaWxlKCk7XG4gICAgaWYgKCFhY3RpdmVGaWxlIHx8IGFjdGl2ZUZpbGUuZXh0ZW5zaW9uICE9PSBcInBkZlwiKSByZXR1cm47XG5cbiAgICBjb25zdCBwZW5kaW5nID0gdGhpcy5wZW5kaW5nSGlnaGxpZ2h0cy5nZXQoYWN0aXZlRmlsZS5wYXRoKTtcbiAgICBpZiAoIXBlbmRpbmcgfHwgcGVuZGluZy5sZW5ndGggPT09IDApIHJldHVybjtcblxuICAgIGNvbnN0IGNvbnRhaW5lciA9IHRoaXMuYXBwLndvcmtzcGFjZS5nZXRBY3RpdmVWaWV3T2ZUeXBlKFZpZXcpPy5jb250YWluZXJFbDtcbiAgICBpZiAoIWNvbnRhaW5lcikgcmV0dXJuO1xuXG4gICAgY29uc3QgYnlQYWdlID0gbmV3IE1hcDxudW1iZXIsIFBkZkhpZ2hsaWdodFBheWxvYWRbXT4oKTtcbiAgICBmb3IgKGNvbnN0IHAgb2YgcGVuZGluZykge1xuICAgICAgY29uc3QgYXJyID0gYnlQYWdlLmdldChwLnBhZ2VOdW1iZXIpID8/IFtdO1xuICAgICAgYXJyLnB1c2gocCk7XG4gICAgICBieVBhZ2Uuc2V0KHAucGFnZU51bWJlciwgYXJyKTtcbiAgICB9XG5cbiAgICBmb3IgKGNvbnN0IFtwYWdlTnVtYmVyLCBoaWdobGlnaHRzXSBvZiBieVBhZ2UuZW50cmllcygpKSB7XG4gICAgICBjb25zdCBwYWdlRGl2ID0gY29udGFpbmVyLnF1ZXJ5U2VsZWN0b3IoXG4gICAgICAgIGAucGFnZVtkYXRhLXBhZ2UtbnVtYmVyPVwiJHtwYWdlTnVtYmVyfVwiXWAsXG4gICAgICApO1xuICAgICAgaWYgKCFwYWdlRGl2IHx8IHBhZ2VEaXYucXVlcnlTZWxlY3RvcihcIi50ZW1wLWhpZ2hsaWdodHMtbGF5ZXJcIikpIGNvbnRpbnVlO1xuICAgICAgZm9yIChjb25zdCBobCBvZiBoaWdobGlnaHRzKSB7XG4gICAgICAgIGNvbnN0IGNzc0NvbG9yID0gYHJnYigke01hdGgucm91bmQoaGwuY29sb3JSZ2JbMF0gKiAyNTUpfSwgJHtNYXRoLnJvdW5kKGhsLmNvbG9yUmdiWzFdICogMjU1KX0sICR7TWF0aC5yb3VuZChobC5jb2xvclJnYlsyXSAqIDI1NSl9KWA7XG4gICAgICAgIHRoaXMuZHJhd1RlbXBvcmFyeUNzc092ZXJsYXkoXG4gICAgICAgICAgaGwucGFnZU51bWJlcixcbiAgICAgICAgICBobC5yZWN0cyxcbiAgICAgICAgICBjc3NDb2xvcixcbiAgICAgICAgICBobC5vcGFjaXR5LFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGNoZWNrSW50ZXJzZWN0aW9uKFxuICAgIGhsUGFnZTogbnVtYmVyLFxuICAgIGhsUmVjdHM6IFJlY3RPdmVybGF5W10sXG4gICAgY3Vyc29yUGFnZTogbnVtYmVyLFxuICAgIGN1cnNvclJlY3Q6IFJlY3RPdmVybGF5LFxuICApOiBib29sZWFuIHtcbiAgICBpZiAoaGxQYWdlICE9PSBjdXJzb3JQYWdlKSByZXR1cm4gZmFsc2U7XG4gICAgY29uc3QgbWFyZ2luID0gMC4wMDU7XG4gICAgZm9yIChjb25zdCByIG9mIGhsUmVjdHMpIHtcbiAgICAgIGlmIChcbiAgICAgICAgY3Vyc29yUmVjdC5wTGVmdCA8PSByLnBMZWZ0ICsgci5wV2lkdGggKyBtYXJnaW4gJiZcbiAgICAgICAgY3Vyc29yUmVjdC5wTGVmdCArIGN1cnNvclJlY3QucFdpZHRoID49IHIucExlZnQgLSBtYXJnaW4gJiZcbiAgICAgICAgY3Vyc29yUmVjdC5wVG9wIDw9IHIucFRvcCArIHIucEhlaWdodCArIG1hcmdpbiAmJlxuICAgICAgICBjdXJzb3JSZWN0LnBUb3AgKyBjdXJzb3JSZWN0LnBIZWlnaHQgPj0gci5wVG9wIC0gbWFyZ2luXG4gICAgICApXG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICBvbnVubG9hZCgpIHtcbiAgICB0aGlzLnN5bmNQZW5kaW5nUXVldWVUb0Rpc2soKS5jYXRjaChjb25zb2xlLmVycm9yKTtcbiAgICB0aGlzLmZsdXNoQ2FjaGUoKS5jYXRjaChjb25zb2xlLmVycm9yKTtcbiAgICBjb25zb2xlLmRlYnVnKFwiQW5ub3RhdGVQREYgYnkgYmlzaHdhYSB1bmxvYWRlZFwiKTtcbiAgfVxuXG4gIGFzeW5jIGxvYWRTZXR0aW5ncygpIHtcbiAgICB0aGlzLnNldHRpbmdzID0gT2JqZWN0LmFzc2lnbih7fSwgREVGQVVMVF9TRVRUSU5HUywgYXdhaXQgdGhpcy5sb2FkRGF0YSgpKTtcbiAgfVxuXG4gIGFzeW5jIHNhdmVTZXR0aW5ncygpIHtcbiAgICBhd2FpdCB0aGlzLnNhdmVEYXRhKHRoaXMuc2V0dGluZ3MpO1xuICB9XG59XG5cbmNsYXNzIFBkZkhpZ2hsaWdodGVyU2V0dGluZ1RhYiBleHRlbmRzIFBsdWdpblNldHRpbmdUYWIge1xuICBwbHVnaW46IFBkZkhpZ2hsaWdodGVyQmlzaHdhYVBsdWdpbjtcblxuICBjb25zdHJ1Y3RvcihhcHA6IEFwcCwgcGx1Z2luOiBQZGZIaWdobGlnaHRlckJpc2h3YWFQbHVnaW4pIHtcbiAgICBzdXBlcihhcHAsIHBsdWdpbik7XG4gICAgdGhpcy5wbHVnaW4gPSBwbHVnaW47XG4gIH1cblxuICBkaXNwbGF5KCk6IHZvaWQge1xuICAgIGNvbnN0IHsgY29udGFpbmVyRWwgfSA9IHRoaXM7XG4gICAgY29udGFpbmVyRWwuZW1wdHkoKTtcbiAgICBuZXcgU2V0dGluZyhjb250YWluZXJFbCkuc2V0TmFtZShcIkFubm90YXRlUERGXCIpLnNldEhlYWRpbmcoKTtcblxuICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgLnNldE5hbWUoXCJBdXRob3IgbmFtZVwiKVxuICAgICAgLnNldERlc2MoXCJTdG9yZWQgbmF0aXZlbHkgaW4gdGhlIFBERiBhbm5vdGF0aW9uIG1ldGFkYXRhLlwiKVxuICAgICAgLmFkZFRleHQoKHRleHQpID0+XG4gICAgICAgIHRleHQuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3MuYXV0aG9yKS5vbkNoYW5nZShhc3luYyAodmFsdWUpID0+IHtcbiAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy5hdXRob3IgPSB2YWx1ZTtcbiAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgfSksXG4gICAgICApO1xuXG4gICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG4gICAgICAuc2V0TmFtZShcIlByaW1hcnkgY29sb3IgKGhvdGtleTogaClcIilcbiAgICAgIC5hZGRDb2xvclBpY2tlcigoY29sb3IpID0+XG4gICAgICAgIGNvbG9yXG4gICAgICAgICAgLnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLmhleENvbG9yUHJpbWFyeSlcbiAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XG4gICAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy5oZXhDb2xvclByaW1hcnkgPSB2YWx1ZTtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgIH0pLFxuICAgICAgKTtcblxuICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgLnNldE5hbWUoXCJTZWNvbmRhcnkgY29sb3IgKGhvdGtleTogZylcIilcbiAgICAgIC5hZGRDb2xvclBpY2tlcigoY29sb3IpID0+XG4gICAgICAgIGNvbG9yXG4gICAgICAgICAgLnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLmhleENvbG9yU2Vjb25kYXJ5KVxuICAgICAgICAgIC5vbkNoYW5nZShhc3luYyAodmFsdWUpID0+IHtcbiAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLmhleENvbG9yU2Vjb25kYXJ5ID0gdmFsdWU7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICB9KSxcbiAgICAgICk7XG5cbiAgICBuZXcgU2V0dGluZyhjb250YWluZXJFbClcbiAgICAgIC5zZXROYW1lKFwiVGVydGlhcnkgY29sb3IgKGhvdGtleTogailcIilcbiAgICAgIC5hZGRDb2xvclBpY2tlcigoY29sb3IpID0+XG4gICAgICAgIGNvbG9yXG4gICAgICAgICAgLnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLmhleENvbG9yVGVydGlhcnkpXG4gICAgICAgICAgLm9uQ2hhbmdlKGFzeW5jICh2YWx1ZSkgPT4ge1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3MuaGV4Q29sb3JUZXJ0aWFyeSA9IHZhbHVlO1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgICAgfSksXG4gICAgICApO1xuXG4gICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG4gICAgICAuc2V0TmFtZShcIkhpZ2hsaWdodCBvcGFjaXR5XCIpXG4gICAgICAuc2V0RGVzYyhcIk5hdGl2ZSBQREYgYWxwaGEgb3BhY2l0eSAoMOKAkzEwMCkuXCIpXG4gICAgICAuYWRkU2xpZGVyKChzbGlkZXIpID0+XG4gICAgICAgIHNsaWRlclxuICAgICAgICAgIC5zZXRMaW1pdHMoMCwgMTAwLCAxKVxuICAgICAgICAgIC5zZXRWYWx1ZSh0aGlzLnBsdWdpbi5zZXR0aW5ncy5vcGFjaXR5KVxuICAgICAgICAgIC5zZXREeW5hbWljVG9vbHRpcCgpXG4gICAgICAgICAgLm9uQ2hhbmdlKGFzeW5jICh2YWx1ZSkgPT4ge1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3Mub3BhY2l0eSA9IHZhbHVlO1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgICAgfSksXG4gICAgICApO1xuXG4gICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG4gICAgICAuc2V0TmFtZShcIlJlc2V0IGNhY2hlXCIpXG4gICAgICAuc2V0RGVzYyhcbiAgICAgICAgXCJDbGVhcnMgYWxsIHBlbmRpbmcgcXVldWVzLCB0aGUgSlNPTiBhdWRpdCBsb2csIGFuZCB0aGUgZW5jcnlwdGVkLWZpbGUgYmxvY2tsaXN0LiBcIiArXG4gICAgICAgICAgXCJVc2UgdGhpcyBpZiB5b3UgcmVtb3ZlZCBhIHBhc3N3b3JkIGZyb20gYSBQREYgYW5kIHdhbnQgdG8gYW5ub3RhdGUgaXQgYWdhaW4uXCIsXG4gICAgICApXG4gICAgICAuYWRkQnV0dG9uKChidG4pID0+XG4gICAgICAgIGJ0blxuICAgICAgICAgIC5zZXRCdXR0b25UZXh0KFwiUmVzZXRcIilcbiAgICAgICAgICAuc2V0V2FybmluZygpXG4gICAgICAgICAgLm9uQ2xpY2soYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4ucGVuZGluZ0hpZ2hsaWdodHMuY2xlYXIoKTtcbiAgICAgICAgICAgIHRoaXMucGx1Z2luLnBlbmRpbmdEZWxldGlvbnMuY2xlYXIoKTtcbiAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLnVuZmx1c2hlZEhpZ2hsaWdodHMgPSB7fTtcbiAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLnVuZmx1c2hlZERlbGV0aW9ucyA9IHt9O1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4uX2VuY3J5cHRlZEZpbGVzLmNsZWFyKCk7IC8vIGFsbG93IHJldHJ5aW5nIHByZXZpb3VzbHkgYmxvY2tlZCBmaWxlc1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZURhdGEoeyBmaWxlTWFwOiB7fSB9KTtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgICAgbmV3IE5vdGljZShcIuKchSBDYWNoZSByZXNldFwiKTtcbiAgICAgICAgICB9KSxcbiAgICAgICk7XG4gIH1cbn1cblxuLy8gYmlzaHdhYWJhYnVcbiJdfQ==
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
                if (((_a = this.app.workspace.activeLeaf) === null || _a === void 0 ? void 0 : _a.view.getViewType()) !== "pdf")
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
                    new Notice("🗑️ Queued highlight cancelled.");
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
                new Notice("⚠️ No saved highlights found in this PDF.");
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
                new Notice("⚠️ No highlight found at the selected position.");
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
        new Setting(containerEl)
            .setName("AnnotatePDF native settings")
            .setHeading();
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
            new Notice("✅ Cache reset.");
        })));
    }
}
// bishwaababu
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1haW4udHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBLE9BQU8sRUFFTCxNQUFNLEVBQ04sZ0JBQWdCLEVBQ2hCLE9BQU8sRUFDUCxNQUFNLEVBQ04sS0FBSyxFQUNMLElBQUksR0FDTCxNQUFNLFVBQVUsQ0FBQztBQUVsQixPQUFPLEVBQ0wsa0JBQWtCLEdBRW5CLE1BQU0sZ0NBQWdDLENBQUM7QUFDeEMsT0FBTyxFQUFFLGtCQUFrQixFQUFFLE1BQU0sOEJBQThCLENBQUM7QUFDbEUsT0FBTyxFQUNMLFlBQVksRUFFWixpQkFBaUIsRUFDakIsY0FBYyxHQUNmLE1BQU0sb0JBQW9CLENBQUM7QUFZNUIsTUFBTSxnQkFBZ0IsR0FBMkI7SUFDL0MsZUFBZSxFQUFFLFNBQVM7SUFDMUIsaUJBQWlCLEVBQUUsU0FBUztJQUM1QixnQkFBZ0IsRUFBRSxTQUFTO0lBQzNCLE9BQU8sRUFBRSxFQUFFO0lBQ1gsTUFBTSxFQUFFLGVBQWU7SUFDdkIsbUJBQW1CLEVBQUUsRUFBRTtJQUN2QixrQkFBa0IsRUFBRSxFQUFFO0NBQ3ZCLENBQUM7QUFFRixTQUFTLGFBQWEsQ0FBQyxHQUFXO0lBQ2hDLE1BQU0sTUFBTSxHQUFHLDJDQUEyQyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUNyRSxPQUFPLE1BQU07UUFDWCxDQUFDLENBQUM7WUFDRSxRQUFRLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBVyxFQUFFLEVBQUUsQ0FBQyxHQUFHLEdBQUc7WUFDdkMsUUFBUSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQVcsRUFBRSxFQUFFLENBQUMsR0FBRyxHQUFHO1lBQ3ZDLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFXLEVBQUUsRUFBRSxDQUFDLEdBQUcsR0FBRztTQUN4QztRQUNILENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUM7QUFDaEIsQ0FBQztB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QXBwLFxuICBQbHVnaW4sXG4gIFBsdWdpblNldHRpbmdUYWIsXG4gIFNldHRpbmcsXG4gIE5vdGljZSxcbiAgVEZpbGUsXG4gIFZpZXcsXG59IGZyb20gXCJvYnNpZGlhblwiO1xuXG5pbXBvcnQge1xuICBTZWxlY3Rpb25FeHRyYWN0b3IsXG4gIFJlY3RPdmVybGF5LFxufSBmcm9tIFwiLi9oaWdobGlnaHQvU2VsZWN0aW9uRXh0cmFjdG9yXCI7XG5pbXBvcnQgeyBIaWdobGlnaHRKc29uU3RvcmUgfSBmcm9tIFwiLi9zdG9yYWdlL0hpZ2hsaWdodEpzb25TdG9yZVwiO1xuaW1wb3J0IHtcbiAgUGRmQW5ub3RhdG9yLFxuICBQZGZIaWdobGlnaHRQYXlsb2FkLFxuICBFbmNyeXB0ZWRQZGZFcnJvcixcbiAgTG9ja2VkUGRmRXJyb3IsXG59IGZyb20gXCIuL3BkZi9QZGZBbm5vdGF0b3JcIjtcblxuZXhwb3J0IGludGVyZmFjZSBQZGZIaWdobGlnaHRlclNldHRpbmdzIHtcbiAgaGV4Q29sb3JQcmltYXJ5OiBzdHJpbmc7XG4gIGhleENvbG9yU2Vjb25kYXJ5OiBzdHJpbmc7XG4gIGhleENvbG9yVGVydGlhcnk6IHN0cmluZztcbiAgb3BhY2l0eTogbnVtYmVyO1xuICBhdXRob3I6IHN0cmluZztcbiAgdW5mbHVzaGVkSGlnaGxpZ2h0czogUmVjb3JkPHN0cmluZywgUGRmSGlnaGxpZ2h0UGF5bG9hZFtdPjtcbiAgdW5mbHVzaGVkRGVsZXRpb25zOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmdbXT47XG59XG5cbmNvbnN0IERFRkFVTFRfU0VUVElOR1M6IFBkZkhpZ2hsaWdodGVyU2V0dGluZ3MgPSB7XG4gIGhleENvbG9yUHJpbWFyeTogXCIjZmZmZjAwXCIsXG4gIGhleENvbG9yU2Vjb25kYXJ5OiBcIiMwMGZmMDBcIixcbiAgaGV4Q29sb3JUZXJ0aWFyeTogXCIjMDBmZmZmXCIsXG4gIG9wYWNpdHk6IDQwLFxuICBhdXRob3I6IFwiT2JzaWRpYW4gVXNlclwiLFxuICB1bmZsdXNoZWRIaWdobGlnaHRzOiB7fSxcbiAgdW5mbHVzaGVkRGVsZXRpb25zOiB7fSxcbn07XG5cbmZ1bmN0aW9uIGhleFRvUmdiQXJyYXkoaGV4OiBzdHJpbmcpOiBbbnVtYmVyLCBudW1iZXIsIG51bWJlcl0ge1xuICBjb25zdCByZXN1bHQgPSAvXiM/KFthLWZcXGRdezJ9KShbYS1mXFxkXXsyfSkoW2EtZlxcZF17Mn0pJC9pLmV4ZWMoaGV4KTtcbiAgcmV0dXJuIHJlc3VsdFxuICAgID8gW1xuICAgICAgICBwYXJzZUludChyZXN1bHRbMV0gYXMgc3RyaW5nLCAxNikgLyAyNTUsXG4gICAgICAgIHBhcnNlSW50KHJlc3VsdFsyXSBhcyBzdHJpbmcsIDE2KSAvIDI1NSxcbiAgICAgICAgcGFyc2VJbnQocmVzdWx0WzNdIGFzIHN0cmluZywgMTYpIC8gMjU1LFxuICAgICAgXVxuICAgIDogWzEsIDEsIDBdO1xufVxuXG5leHBvcnQgZGVmYXVsdCBjbGFzcyBQZGZIaWdobGlnaHRlckJpc2h3YWFQbHVnaW4gZXh0ZW5kcyBQbHVnaW4ge1xuICBzZXR0aW5nczogUGRmSGlnaGxpZ2h0ZXJTZXR0aW5ncztcbiAgc2VsZWN0aW9uRXh0cmFjdG9yOiBTZWxlY3Rpb25FeHRyYWN0b3I7XG4gIGhpZ2hsaWdodFN0b3JlOiBIaWdobGlnaHRKc29uU3RvcmU7XG4gIHBkZkFubm90YXRvcjogUGRmQW5ub3RhdG9yO1xuXG4gIHBlbmRpbmdIaWdobGlnaHRzOiBNYXA8c3RyaW5nLCBQZGZIaWdobGlnaHRQYXlsb2FkW10+ID0gbmV3IE1hcCgpO1xuICBwZW5kaW5nRGVsZXRpb25zOiBNYXA8c3RyaW5nLCBzdHJpbmdbXT4gPSBuZXcgTWFwKCk7XG5cbiAgLy8gQ29uY3VycmVuY3kgZ3VhcmRcbiAgcHJpdmF0ZSBfaXNGbHVzaGluZyA9IGZhbHNlO1xuICBwcml2YXRlIF9mbHVzaFBlbmRpbmcgPSBmYWxzZTtcblxuICBwdWJsaWMgX2VuY3J5cHRlZEZpbGVzOiBTZXQ8c3RyaW5nPiA9IG5ldyBTZXQoKTtcblxuICBhc3luYyBvbmxvYWQoKSB7XG4gICAgYXdhaXQgdGhpcy5sb2FkU2V0dGluZ3MoKTtcblxuICAgIGlmICh0aGlzLnNldHRpbmdzLnVuZmx1c2hlZEhpZ2hsaWdodHMpIHtcbiAgICAgIGZvciAoY29uc3QgW2ssIHZdIG9mIE9iamVjdC5lbnRyaWVzKHRoaXMuc2V0dGluZ3MudW5mbHVzaGVkSGlnaGxpZ2h0cykpIHtcbiAgICAgICAgdGhpcy5wZW5kaW5nSGlnaGxpZ2h0cy5zZXQoaywgdik7XG4gICAgICB9XG4gICAgfVxuICAgIGlmICh0aGlzLnNldHRpbmdzLnVuZmx1c2hlZERlbGV0aW9ucykge1xuICAgICAgZm9yIChjb25zdCBbaywgdl0gb2YgT2JqZWN0LmVudHJpZXModGhpcy5zZXR0aW5ncy51bmZsdXNoZWREZWxldGlvbnMpKSB7XG4gICAgICAgIHRoaXMucGVuZGluZ0RlbGV0aW9ucy5zZXQoaywgdik7XG4gICAgICB9XG4gICAgfVxuXG4gICAgdGhpcy5oaWdobGlnaHRTdG9yZSA9IG5ldyBIaWdobGlnaHRKc29uU3RvcmUodGhpcyk7XG4gICAgdGhpcy5zZWxlY3Rpb25FeHRyYWN0b3IgPSBuZXcgU2VsZWN0aW9uRXh0cmFjdG9yKCk7XG4gICAgdGhpcy5wZGZBbm5vdGF0b3IgPSBuZXcgUGRmQW5ub3RhdG9yKHRoaXMuYXBwKTtcblxuICAgIHRoaXMuYWRkU2V0dGluZ1RhYihuZXcgUGRmSGlnaGxpZ2h0ZXJTZXR0aW5nVGFiKHRoaXMuYXBwLCB0aGlzKSk7XG5cbiAgICBzZXRUaW1lb3V0KCgpID0+IHZvaWQgdGhpcy5mbHVzaENhY2hlKCksIDMwMDApO1xuXG4gICAgdGhpcy5yZWdpc3RlckludGVydmFsKFxuICAgICAgd2luZG93LnNldEludGVydmFsKCgpID0+IHRoaXMucmVpbmplY3RDc3NPdmVybGF5cygpLCAxNTAwKSxcbiAgICApO1xuXG4gICAgdGhpcy5hZGRDb21tYW5kKHtcbiAgICAgIGlkOiBcImhpZ2hsaWdodC1wZGYtcHJpbWFyeVwiLFxuICAgICAgbmFtZTogXCJIaWdobGlnaHQgc2VsZWN0ZWQgUERGIHRleHQgKHByaW1hcnkpXCIsXG4gICAgICBjaGVja0NhbGxiYWNrOiAoY2hlY2tpbmcpID0+IHtcbiAgICAgICAgaWYgKFxuICAgICAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS5nZXRBY3RpdmVWaWV3T2ZUeXBlKFZpZXcpPy5nZXRWaWV3VHlwZSgpID09PSBcInBkZlwiXG4gICAgICAgICkge1xuICAgICAgICAgIGlmICghY2hlY2tpbmcpXG4gICAgICAgICAgICB2b2lkIHRoaXMuZXhlY3V0ZUhpZ2hsaWdodCh0aGlzLnNldHRpbmdzLmhleENvbG9yUHJpbWFyeSk7XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgfSxcbiAgICB9KTtcblxuICAgIHRoaXMuYWRkQ29tbWFuZCh7XG4gICAgICBpZDogXCJoaWdobGlnaHQtcGRmLXNlY29uZGFyeVwiLFxuICAgICAgbmFtZTogXCJIaWdobGlnaHQgc2VsZWN0ZWQgUERGIHRleHQgKHNlY29uZGFyeSlcIixcbiAgICAgIGNoZWNrQ2FsbGJhY2s6IChjaGVja2luZykgPT4ge1xuICAgICAgICBpZiAoXG4gICAgICAgICAgdGhpcy5hcHAud29ya3NwYWNlLmdldEFjdGl2ZVZpZXdPZlR5cGUoVmlldyk/LmdldFZpZXdUeXBlKCkgPT09IFwicGRmXCJcbiAgICAgICAgKSB7XG4gICAgICAgICAgaWYgKCFjaGVja2luZylcbiAgICAgICAgICAgIHZvaWQgdGhpcy5leGVjdXRlSGlnaGxpZ2h0KHRoaXMuc2V0dGluZ3MuaGV4Q29sb3JTZWNvbmRhcnkpO1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICB0aGlzLmFkZENvbW1hbmQoe1xuICAgICAgaWQ6IFwiaGlnaGxpZ2h0LXBkZi10ZXJ0aWFyeVwiLFxuICAgICAgbmFtZTogXCJIaWdobGlnaHQgc2VsZWN0ZWQgUERGIHRleHQgKHRlcnRpYXJ5KVwiLFxuICAgICAgY2hlY2tDYWxsYmFjazogKGNoZWNraW5nKSA9PiB7XG4gICAgICAgIGlmIChcbiAgICAgICAgICB0aGlzLmFwcC53b3Jrc3BhY2UuZ2V0QWN0aXZlVmlld09mVHlwZShWaWV3KT8uZ2V0Vmlld1R5cGUoKSA9PT0gXCJwZGZcIlxuICAgICAgICApIHtcbiAgICAgICAgICBpZiAoIWNoZWNraW5nKVxuICAgICAgICAgICAgdm9pZCB0aGlzLmV4ZWN1dGVIaWdobGlnaHQodGhpcy5zZXR0aW5ncy5oZXhDb2xvclRlcnRpYXJ5KTtcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgdGhpcy5hZGRDb21tYW5kKHtcbiAgICAgIGlkOiBcInJlbW92ZS1wZGYtaGlnaGxpZ2h0XCIsXG4gICAgICBuYW1lOiBcIlJlbW92ZSBoaWdobGlnaHQgdW5kZXIgc2VsZWN0aW9uXCIsXG4gICAgICBjaGVja0NhbGxiYWNrOiAoY2hlY2tpbmcpID0+IHtcbiAgICAgICAgaWYgKFxuICAgICAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS5nZXRBY3RpdmVWaWV3T2ZUeXBlKFZpZXcpPy5nZXRWaWV3VHlwZSgpID09PSBcInBkZlwiXG4gICAgICAgICkge1xuICAgICAgICAgIGlmICghY2hlY2tpbmcpIHZvaWQgdGhpcy5leGVjdXRlUmVtb3ZlSGlnaGxpZ2h0KCk7XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgfSxcbiAgICB9KTtcblxuICAgIHRoaXMucmVnaXN0ZXJEb21FdmVudChkb2N1bWVudCwgXCJrZXlkb3duXCIsIChldnQ6IEtleWJvYXJkRXZlbnQpID0+IHtcbiAgICAgIGlmICh0aGlzLmFwcC53b3Jrc3BhY2UuYWN0aXZlTGVhZj8udmlldy5nZXRWaWV3VHlwZSgpICE9PSBcInBkZlwiKSByZXR1cm47XG5cbiAgICAgIGNvbnN0IHRhcmdldCA9IGV2dC50YXJnZXQgYXMgSFRNTEVsZW1lbnQ7XG4gICAgICBpZiAoXG4gICAgICAgIHRhcmdldD8udGFnTmFtZSA9PT0gXCJJTlBVVFwiIHx8XG4gICAgICAgIHRhcmdldD8udGFnTmFtZSA9PT0gXCJURVhUQVJFQVwiIHx8XG4gICAgICAgIHRhcmdldD8uaXNDb250ZW50RWRpdGFibGVcbiAgICAgIClcbiAgICAgICAgcmV0dXJuO1xuXG4gICAgICBjb25zdCBzZWxlY3Rpb24gPSB3aW5kb3cuZ2V0U2VsZWN0aW9uKCk7XG4gICAgICBjb25zdCBoYXNTZWxlY3Rpb24gPVxuICAgICAgICBzZWxlY3Rpb24gJiZcbiAgICAgICAgIXNlbGVjdGlvbi5pc0NvbGxhcHNlZCAmJlxuICAgICAgICBzZWxlY3Rpb24udG9TdHJpbmcoKS50cmltKCkubGVuZ3RoID4gMDtcblxuICAgICAgaWYgKGV2dC5rZXkudG9Mb3dlckNhc2UoKSA9PT0gXCJoXCIgJiYgaGFzU2VsZWN0aW9uKSB7XG4gICAgICAgIHZvaWQgdGhpcy5leGVjdXRlSGlnaGxpZ2h0KHRoaXMuc2V0dGluZ3MuaGV4Q29sb3JQcmltYXJ5KTtcbiAgICAgICAgZXZ0LnByZXZlbnREZWZhdWx0KCk7XG4gICAgICB9IGVsc2UgaWYgKGV2dC5rZXkudG9Mb3dlckNhc2UoKSA9PT0gXCJnXCIgJiYgaGFzU2VsZWN0aW9uKSB7XG4gICAgICAgIHZvaWQgdGhpcy5leGVjdXRlSGlnaGxpZ2h0KHRoaXMuc2V0dGluZ3MuaGV4Q29sb3JTZWNvbmRhcnkpO1xuICAgICAgICBldnQucHJldmVudERlZmF1bHQoKTtcbiAgICAgIH0gZWxzZSBpZiAoZXZ0LmtleS50b0xvd2VyQ2FzZSgpID09PSBcImpcIiAmJiBoYXNTZWxlY3Rpb24pIHtcbiAgICAgICAgdm9pZCB0aGlzLmV4ZWN1dGVIaWdobGlnaHQodGhpcy5zZXR0aW5ncy5oZXhDb2xvclRlcnRpYXJ5KTtcbiAgICAgICAgZXZ0LnByZXZlbnREZWZhdWx0KCk7XG4gICAgICB9IGVsc2UgaWYgKFxuICAgICAgICAoZXZ0LmtleSA9PT0gXCJEZWxldGVcIiB8fCBldnQua2V5ID09PSBcIkJhY2tzcGFjZVwiKSAmJlxuICAgICAgICBoYXNTZWxlY3Rpb25cbiAgICAgICkge1xuICAgICAgICB2b2lkIHRoaXMuZXhlY3V0ZVJlbW92ZUhpZ2hsaWdodCgpO1xuICAgICAgICBldnQucHJldmVudERlZmF1bHQoKTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIHRoaXMucmVnaXN0ZXJFdmVudChcbiAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS5vbihcImFjdGl2ZS1sZWFmLWNoYW5nZVwiLCAoKSA9PiB0aGlzLmZsdXNoQ2FjaGUoKSksXG4gICAgKTtcbiAgICB0aGlzLnJlZ2lzdGVyRXZlbnQodGhpcy5hcHAud29ya3NwYWNlLm9uKFwicXVpdFwiLCAoKSA9PiB0aGlzLmZsdXNoQ2FjaGUoKSkpO1xuXG4gICAgY29uc29sZS5kZWJ1ZyhcIkFubm90YXRlUERGIGJ5IGJpc2h3YWEgbG9hZGVkXCIpO1xuICB9XG5cbiAgLy8g4pSA4pSA4pSAIENvbmN1cnJlbmN5LXNhZmUgZmx1c2gg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIGFzeW5jIGZsdXNoQ2FjaGUoKSB7XG4gICAgaWYgKHRoaXMuX2lzRmx1c2hpbmcpIHtcbiAgICAgIHRoaXMuX2ZsdXNoUGVuZGluZyA9IHRydWU7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHRoaXMuX2lzRmx1c2hpbmcgPSB0cnVlO1xuICAgIHRoaXMuX2ZsdXNoUGVuZGluZyA9IGZhbHNlO1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCB0aGlzLl9kb0ZsdXNoKCk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHRoaXMuX2lzRmx1c2hpbmcgPSBmYWxzZTtcbiAgICAgIGlmICh0aGlzLl9mbHVzaFBlbmRpbmcpIHtcbiAgICAgICAgdGhpcy5fZmx1c2hQZW5kaW5nID0gZmFsc2U7XG4gICAgICAgIHNldFRpbWVvdXQoKCkgPT4gdm9pZCB0aGlzLmZsdXNoQ2FjaGUoKSwgNTApO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgX2RvRmx1c2goKSB7XG4gICAgaWYgKHRoaXMucGVuZGluZ0hpZ2hsaWdodHMuc2l6ZSA9PT0gMCAmJiB0aGlzLnBlbmRpbmdEZWxldGlvbnMuc2l6ZSA9PT0gMClcbiAgICAgIHJldHVybjtcblxuICAgIGNvbnN0IGhpZ2hsaWdodHNUb1Byb2Nlc3MgPSBuZXcgTWFwKHRoaXMucGVuZGluZ0hpZ2hsaWdodHMpO1xuICAgIGNvbnN0IGRlbGV0aW9uc1RvUHJvY2VzcyA9IG5ldyBNYXAodGhpcy5wZW5kaW5nRGVsZXRpb25zKTtcblxuICAgIGNvbnN0IGFsbFBhdGhzID0gbmV3IFNldChbXG4gICAgICAuLi5oaWdobGlnaHRzVG9Qcm9jZXNzLmtleXMoKSxcbiAgICAgIC4uLmRlbGV0aW9uc1RvUHJvY2Vzcy5rZXlzKCksXG4gICAgXSk7XG5cbiAgICBmb3IgKGNvbnN0IGZpbGVQYXRoIG9mIGFsbFBhdGhzKSB7XG4gICAgICBpZiAodGhpcy5fZW5jcnlwdGVkRmlsZXMuaGFzKGZpbGVQYXRoKSkgY29udGludWU7XG5cbiAgICAgIGNvbnN0IGZpbGUgPSB0aGlzLmFwcC52YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgoZmlsZVBhdGgpO1xuICAgICAgaWYgKCEoZmlsZSBpbnN0YW5jZW9mIFRGaWxlKSkgY29udGludWU7XG5cbiAgICAgIGNvbnN0IGhpZ2hsaWdodHMgPSBoaWdobGlnaHRzVG9Qcm9jZXNzLmdldChmaWxlUGF0aCkgPz8gW107XG4gICAgICBjb25zdCBkZWxldGlvbnMgPSBkZWxldGlvbnNUb1Byb2Nlc3MuZ2V0KGZpbGVQYXRoKSA/PyBbXTtcbiAgICAgIGlmIChoaWdobGlnaHRzLmxlbmd0aCA9PT0gMCAmJiBkZWxldGlvbnMubGVuZ3RoID09PSAwKSBjb250aW51ZTtcblxuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgdGhpcy5wZGZBbm5vdGF0b3IuYXBwbHlCYXRjaFVwZGF0ZXNUb1BkZihcbiAgICAgICAgICBmaWxlLFxuICAgICAgICAgIGhpZ2hsaWdodHMsXG4gICAgICAgICAgZGVsZXRpb25zLFxuICAgICAgICApO1xuXG4gICAgICAgIGNvbnN0IGJ1bGtKc29uRWxlbWVudHMgPSBoaWdobGlnaHRzLm1hcCgocCkgPT4gKHtcbiAgICAgICAgICBpZDogcC5pZCxcbiAgICAgICAgICBwYWdlOiBwLnBhZ2VOdW1iZXIsXG4gICAgICAgICAgcmVjdHM6IHAucmVjdHMsXG4gICAgICAgICAgdGV4dDogXCJCdWxrIEFubm90YXRlZCBEYXRhXCIsXG4gICAgICAgICAgY29sb3I6IGByZ2IoJHtNYXRoLnJvdW5kKHAuY29sb3JSZ2JbMF0gKiAyNTUpfSwgJHtNYXRoLnJvdW5kKHAuY29sb3JSZ2JbMV0gKiAyNTUpfSwgJHtNYXRoLnJvdW5kKHAuY29sb3JSZ2JbMl0gKiAyNTUpfSlgLFxuICAgICAgICAgIG9wYWNpdHk6IHAub3BhY2l0eSxcbiAgICAgICAgICBhdXRob3I6IHAuYXV0aG9yLFxuICAgICAgICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcbiAgICAgICAgfSkpO1xuICAgICAgICBjb25zdCBleGFjdElkc1RvRGVsZXRlID0gZGVsZXRpb25zLmZpbHRlcihcbiAgICAgICAgICAoaWQpID0+ICFpZC5zdGFydHNXaXRoKFwiU1BBVElBTDpcIiksXG4gICAgICAgICk7XG4gICAgICAgIGF3YWl0IHRoaXMuaGlnaGxpZ2h0U3RvcmUuYXBwbHlCYXRjaFVwZGF0ZXNUb0pzb24oXG4gICAgICAgICAgZmlsZVBhdGgsXG4gICAgICAgICAgYnVsa0pzb25FbGVtZW50cyxcbiAgICAgICAgICBleGFjdElkc1RvRGVsZXRlLFxuICAgICAgICApO1xuXG4gICAgICAgIHRoaXMucGVuZGluZ0hpZ2hsaWdodHMuZGVsZXRlKGZpbGVQYXRoKTtcbiAgICAgICAgdGhpcy5wZW5kaW5nRGVsZXRpb25zLmRlbGV0ZShmaWxlUGF0aCk7XG4gICAgICAgIGF3YWl0IHRoaXMuc3luY1BlbmRpbmdRdWV1ZVRvRGlzaygpO1xuXG4gICAgICAgIGlmIChoaWdobGlnaHRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICBuZXcgTm90aWNlKGDinIUgSGlnaGxpZ2h0cyBzYXZlZCB0byAke2ZpbGUubmFtZX1gKTtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBpZiAoZSBpbnN0YW5jZW9mIEVuY3J5cHRlZFBkZkVycm9yKSB7XG4gICAgICAgICAgbmV3IE5vdGljZShcbiAgICAgICAgICAgIGDwn5SSIFwiJHtmaWxlLm5hbWV9XCIgaXMgcGFzc3dvcmQtcHJvdGVjdGVkLlxcblxcbkFubm90YXRlUERGIGNhbm5vdCBtb2RpZnkgZW5jcnlwdGVkIFBERnMuIEhpZ2hsaWdodHMgaGF2ZSBiZWVuIGRpc2NhcmRlZC5gLFxuICAgICAgICAgICAgODAwMCxcbiAgICAgICAgICApO1xuICAgICAgICAgIC8vIENsZWFyIHF1ZXVlIHNvIHdlIG5ldmVyIHJldHJ5IHRoaXMgZmlsZVxuICAgICAgICAgIHRoaXMucGVuZGluZ0hpZ2hsaWdodHMuZGVsZXRlKGZpbGVQYXRoKTtcbiAgICAgICAgICB0aGlzLnBlbmRpbmdEZWxldGlvbnMuZGVsZXRlKGZpbGVQYXRoKTtcbiAgICAgICAgICB0aGlzLl9lbmNyeXB0ZWRGaWxlcy5hZGQoZmlsZVBhdGgpO1xuICAgICAgICAgIGF3YWl0IHRoaXMuc3luY1BlbmRpbmdRdWV1ZVRvRGlzaygpO1xuICAgICAgICB9IGVsc2UgaWYgKGUgaW5zdGFuY2VvZiBMb2NrZWRQZGZFcnJvcikge1xuICAgICAgICAgIG5ldyBOb3RpY2UoXG4gICAgICAgICAgICBg4p2MIFwiJHtmaWxlLm5hbWV9XCIgaXMgb3BlbiBpbiBhbm90aGVyIGFwcC5cXG5cXG5DbG9zZSBpdCB0aGVyZSBmaXJzdCwgdGhlbiBzd2l0Y2ggdGFicyB0byBzYXZlIHlvdXIgaGlnaGxpZ2h0cy5gLFxuICAgICAgICAgICAgNjAwMCxcbiAgICAgICAgICApO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIC8vIOKUgOKUgCBVbmtub3duIGVycm9yIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAgICAgICAgIG5ldyBOb3RpY2UoXG4gICAgICAgICAgICBg4pqg77iPIEZhaWxlZCB0byBzYXZlIGhpZ2hsaWdodHMgdG8gXCIke2ZpbGUubmFtZX1cIi5cXG5cXG5DaGVjayB0aGUgZGV2ZWxvcGVyIGNvbnNvbGUgZm9yIGRldGFpbHMuYCxcbiAgICAgICAgICAgIDYwMDAsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnNvbGUuZXJyb3IoXCJbQW5ub3RhdGVQREZdIEZsdXNoIGVycm9yOlwiLCBlKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBhc3luYyBzeW5jUGVuZGluZ1F1ZXVlVG9EaXNrKCkge1xuICAgIHRoaXMuc2V0dGluZ3MudW5mbHVzaGVkSGlnaGxpZ2h0cyA9IE9iamVjdC5mcm9tRW50cmllcyhcbiAgICAgIHRoaXMucGVuZGluZ0hpZ2hsaWdodHMsXG4gICAgKTtcbiAgICB0aGlzLnNldHRpbmdzLnVuZmx1c2hlZERlbGV0aW9ucyA9IE9iamVjdC5mcm9tRW50cmllcyhcbiAgICAgIHRoaXMucGVuZGluZ0RlbGV0aW9ucyxcbiAgICApO1xuICAgIGF3YWl0IHRoaXMuc2F2ZVNldHRpbmdzKCk7XG4gIH1cblxuICBhc3luYyBleGVjdXRlSGlnaGxpZ2h0KGNvbG9ySGV4OiBzdHJpbmcpIHtcbiAgICBjb25zdCBhY3RpdmVGaWxlID0gdGhpcy5hcHAud29ya3NwYWNlLmdldEFjdGl2ZUZpbGUoKTtcbiAgICBpZiAoIWFjdGl2ZUZpbGUgfHwgYWN0aXZlRmlsZS5leHRlbnNpb24gIT09IFwicGRmXCIpIHJldHVybjtcblxuICAgIGlmICh0aGlzLl9lbmNyeXB0ZWRGaWxlcy5oYXMoYWN0aXZlRmlsZS5wYXRoKSkge1xuICAgICAgbmV3IE5vdGljZShcbiAgICAgICAgYPCflJIgXCIke2FjdGl2ZUZpbGUubmFtZX1cIiBpcyBwYXNzd29yZC1wcm90ZWN0ZWQgYW5kIGNhbm5vdCBiZSBhbm5vdGF0ZWQuYCxcbiAgICAgICk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3Qgc2VsZWN0aW9uRGF0YSA9IHRoaXMuc2VsZWN0aW9uRXh0cmFjdG9yLmdldEFjdGl2ZVNlbGVjdGlvbigpO1xuICAgIGlmICghc2VsZWN0aW9uRGF0YSB8fCBzZWxlY3Rpb25EYXRhLnJlY3RzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgbmV3IE5vdGljZShcIk5vIHRleHQgc2VsZWN0ZWQgdG8gaGlnaGxpZ2h0XCIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IG9wYWNpdHlGbG9hdCA9IHRoaXMuc2V0dGluZ3Mub3BhY2l0eSAvIDEwMDtcbiAgICBjb25zdCBjb2xvckFycmF5ID0gaGV4VG9SZ2JBcnJheShjb2xvckhleCk7XG4gICAgY29uc3QgaGlnaGxpZ2h0SWQgPSB3aW5kb3cuY3J5cHRvLnJhbmRvbVVVSUQoKTtcblxuICAgIHRoaXMuZHJhd1RlbXBvcmFyeUNzc092ZXJsYXkoXG4gICAgICBzZWxlY3Rpb25EYXRhLnBhZ2VOdW1iZXIsXG4gICAgICBzZWxlY3Rpb25EYXRhLnJlY3RzLFxuICAgICAgY29sb3JIZXgsXG4gICAgICBvcGFjaXR5RmxvYXQsXG4gICAgKTtcblxuICAgIGNvbnN0IHBheWxvYWQ6IFBkZkhpZ2hsaWdodFBheWxvYWQgPSB7XG4gICAgICBwYWdlTnVtYmVyOiBzZWxlY3Rpb25EYXRhLnBhZ2VOdW1iZXIsXG4gICAgICByZWN0czogc2VsZWN0aW9uRGF0YS5yZWN0cyxcbiAgICAgIGNvbG9yUmdiOiBjb2xvckFycmF5LFxuICAgICAgb3BhY2l0eTogb3BhY2l0eUZsb2F0LFxuICAgICAgYXV0aG9yOiB0aGlzLnNldHRpbmdzLmF1dGhvcixcbiAgICAgIGlkOiBoaWdobGlnaHRJZCxcbiAgICB9O1xuXG4gICAgY29uc3QgZXhpc3RpbmcgPSB0aGlzLnBlbmRpbmdIaWdobGlnaHRzLmdldChhY3RpdmVGaWxlLnBhdGgpID8/IFtdO1xuICAgIGV4aXN0aW5nLnB1c2gocGF5bG9hZCk7XG4gICAgdGhpcy5wZW5kaW5nSGlnaGxpZ2h0cy5zZXQoYWN0aXZlRmlsZS5wYXRoLCBleGlzdGluZyk7XG4gICAgYXdhaXQgdGhpcy5zeW5jUGVuZGluZ1F1ZXVlVG9EaXNrKCk7XG4gICAgd2luZG93LmdldFNlbGVjdGlvbigpPy5lbXB0eSgpO1xuICB9XG5cbiAgYXN5bmMgZXhlY3V0ZVJlbW92ZUhpZ2hsaWdodCgpIHtcbiAgICBjb25zdCBhY3RpdmVGaWxlID0gdGhpcy5hcHAud29ya3NwYWNlLmdldEFjdGl2ZUZpbGUoKTtcbiAgICBpZiAoIWFjdGl2ZUZpbGUgfHwgYWN0aXZlRmlsZS5leHRlbnNpb24gIT09IFwicGRmXCIpIHJldHVybjtcblxuICAgIGlmICh0aGlzLl9lbmNyeXB0ZWRGaWxlcy5oYXMoYWN0aXZlRmlsZS5wYXRoKSkge1xuICAgICAgbmV3IE5vdGljZShcbiAgICAgICAgYPCflJIgXCIke2FjdGl2ZUZpbGUubmFtZX1cIiBpcyBwYXNzd29yZC1wcm90ZWN0ZWQgYW5kIGNhbm5vdCBiZSBtb2RpZmllZC5gLFxuICAgICAgKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCBzZWxlY3Rpb25EYXRhID0gdGhpcy5zZWxlY3Rpb25FeHRyYWN0b3IuZ2V0QWN0aXZlU2VsZWN0aW9uKCk7XG4gICAgaWYgKCFzZWxlY3Rpb25EYXRhIHx8IHNlbGVjdGlvbkRhdGEucmVjdHMubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgY29uc3QgY3Vyc29yUmVjdCA9IHNlbGVjdGlvbkRhdGEucmVjdHNbMF07XG4gICAgaWYgKCFjdXJzb3JSZWN0KSByZXR1cm47XG5cbiAgICB3aW5kb3cuZ2V0U2VsZWN0aW9uKCk/LmVtcHR5KCk7XG5cbiAgICAvLyBTdGVwIDE6IHBlbmRpbmcgcXVldWVcbiAgICBjb25zdCBxTGlzdCA9IHRoaXMucGVuZGluZ0hpZ2hsaWdodHMuZ2V0KGFjdGl2ZUZpbGUucGF0aCk7XG4gICAgaWYgKHFMaXN0ICYmIHFMaXN0Lmxlbmd0aCA+IDApIHtcbiAgICAgIGNvbnN0IGJlZm9yZSA9IHFMaXN0Lmxlbmd0aDtcbiAgICAgIGNvbnN0IGZpbHRlcmVkID0gcUxpc3QuZmlsdGVyKFxuICAgICAgICAocCkgPT5cbiAgICAgICAgICAhdGhpcy5jaGVja0ludGVyc2VjdGlvbihcbiAgICAgICAgICAgIHAucGFnZU51bWJlcixcbiAgICAgICAgICAgIHAucmVjdHMsXG4gICAgICAgICAgICBzZWxlY3Rpb25EYXRhLnBhZ2VOdW1iZXIsXG4gICAgICAgICAgICBjdXJzb3JSZWN0LFxuICAgICAgICAgICksXG4gICAgICApO1xuICAgICAgaWYgKGZpbHRlcmVkLmxlbmd0aCA8IGJlZm9yZSkge1xuICAgICAgICB0aGlzLnBlbmRpbmdIaWdobGlnaHRzLnNldChhY3RpdmVGaWxlLnBhdGgsIGZpbHRlcmVkKTtcbiAgICAgICAgdGhpcy5yZW1vdmVUZW1wb3JhcnlDc3NPdmVybGF5KGN1cnNvclJlY3QsIHNlbGVjdGlvbkRhdGEucGFnZU51bWJlcik7XG4gICAgICAgIGF3YWl0IHRoaXMuc3luY1BlbmRpbmdRdWV1ZVRvRGlzaygpO1xuICAgICAgICBuZXcgTm90aWNlKFwi8J+Xke+4jyBRdWV1ZWQgaGlnaGxpZ2h0IGNhbmNlbGxlZC5cIik7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBTdGVwIDI6IHJlYWQgZGlyZWN0bHkgZnJvbSBQREYgYmluYXJ5XG4gICAgbGV0IHNhdmVkQW5ub3RhdGlvbnM7XG4gICAgdHJ5IHtcbiAgICAgIHNhdmVkQW5ub3RhdGlvbnMgPVxuICAgICAgICBhd2FpdCB0aGlzLnBkZkFubm90YXRvci5yZWFkQW5ub3RhdGlvbnNGcm9tUGRmKGFjdGl2ZUZpbGUpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGlmIChlIGluc3RhbmNlb2YgRW5jcnlwdGVkUGRmRXJyb3IpIHtcbiAgICAgICAgdGhpcy5fZW5jcnlwdGVkRmlsZXMuYWRkKGFjdGl2ZUZpbGUucGF0aCk7XG4gICAgICAgIG5ldyBOb3RpY2UoXG4gICAgICAgICAgYPCflJIgXCIke2FjdGl2ZUZpbGUubmFtZX1cIiBpcyBwYXNzd29yZC1wcm90ZWN0ZWQgYW5kIGNhbm5vdCBiZSBtb2RpZmllZC5gLFxuICAgICAgICApO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBuZXcgTm90aWNlKFxuICAgICAgICBg4pqg77iPIENvdWxkIG5vdCByZWFkIFwiJHthY3RpdmVGaWxlLm5hbWV9XCIuIENoZWNrIHRoZSBjb25zb2xlIGZvciBkZXRhaWxzLmAsXG4gICAgICApO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmIChzYXZlZEFubm90YXRpb25zLmxlbmd0aCA9PT0gMCkge1xuICAgICAgbmV3IE5vdGljZShcIuKaoO+4jyBObyBzYXZlZCBoaWdobGlnaHRzIGZvdW5kIGluIHRoaXMgUERGLlwiKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCBtYXJnaW4gPSAwLjAwNTtcbiAgICBjb25zdCB0YXJnZXQgPSBzYXZlZEFubm90YXRpb25zLmZpbmQoKGFubikgPT4ge1xuICAgICAgaWYgKGFubi5wYWdlTnVtYmVyICE9PSBzZWxlY3Rpb25EYXRhLnBhZ2VOdW1iZXIpIHJldHVybiBmYWxzZTtcbiAgICAgIHJldHVybiAoXG4gICAgICAgIGN1cnNvclJlY3QucExlZnQgPD0gYW5uLnBMZWZ0ICsgYW5uLnBXaWR0aCArIG1hcmdpbiAmJlxuICAgICAgICBjdXJzb3JSZWN0LnBMZWZ0ICsgY3Vyc29yUmVjdC5wV2lkdGggPj0gYW5uLnBMZWZ0IC0gbWFyZ2luICYmXG4gICAgICAgIGN1cnNvclJlY3QucFRvcCA8PSBhbm4ucFRvcCArIGFubi5wSGVpZ2h0ICsgbWFyZ2luICYmXG4gICAgICAgIGN1cnNvclJlY3QucFRvcCArIGN1cnNvclJlY3QucEhlaWdodCA+PSBhbm4ucFRvcCAtIG1hcmdpblxuICAgICAgKTtcbiAgICB9KTtcblxuICAgIGlmICghdGFyZ2V0KSB7XG4gICAgICBuZXcgTm90aWNlKFwi4pqg77iPIE5vIGhpZ2hsaWdodCBmb3VuZCBhdCB0aGUgc2VsZWN0ZWQgcG9zaXRpb24uXCIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IGRlbFEgPSB0aGlzLnBlbmRpbmdEZWxldGlvbnMuZ2V0KGFjdGl2ZUZpbGUucGF0aCkgPz8gW107XG4gICAgaWYgKHRhcmdldC5pZCkgZGVsUS5wdXNoKHRhcmdldC5pZCk7XG4gICAgZGVsUS5wdXNoKFxuICAgICAgYFNQQVRJQUw6JHt0YXJnZXQucGFnZU51bWJlcn06JHt0YXJnZXQucExlZnR9LCR7dGFyZ2V0LnBUb3B9LCR7dGFyZ2V0LnBXaWR0aH0sJHt0YXJnZXQucEhlaWdodH1gLFxuICAgICk7XG4gICAgdGhpcy5wZW5kaW5nRGVsZXRpb25zLnNldChhY3RpdmVGaWxlLnBhdGgsIGRlbFEpO1xuICAgIGF3YWl0IHRoaXMuc3luY1BlbmRpbmdRdWV1ZVRvRGlzaygpO1xuICAgIGF3YWl0IHRoaXMuZmx1c2hDYWNoZSgpO1xuICB9XG5cbiAgLy8g4pSA4pSA4pSAIENTUyBvdmVybGF5IGhlbHBlcnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIGRyYXdUZW1wb3JhcnlDc3NPdmVybGF5KFxuICAgIHBhZ2VOdW1iZXI6IG51bWJlcixcbiAgICByZWN0czogUmVjdE92ZXJsYXlbXSxcbiAgICBjb2xvckhleDogc3RyaW5nLFxuICAgIG9wYWNpdHlGbG9hdDogbnVtYmVyLFxuICApIHtcbiAgICBjb25zdCBjb250YWluZXIgPSB0aGlzLmFwcC53b3Jrc3BhY2UuZ2V0QWN0aXZlVmlld09mVHlwZShWaWV3KT8uY29udGFpbmVyRWw7XG4gICAgaWYgKCFjb250YWluZXIpIHJldHVybjtcblxuICAgIGNvbnN0IHBhZ2VEaXYgPSBjb250YWluZXIucXVlcnlTZWxlY3RvcihcbiAgICAgIGAucGFnZVtkYXRhLXBhZ2UtbnVtYmVyPVwiJHtwYWdlTnVtYmVyfVwiXWAsXG4gICAgKTtcbiAgICBpZiAoIXBhZ2VEaXYpIHJldHVybjtcblxuICAgIC8vIEFmdGVyXG4gICAgbGV0IHRlbXBMYXllciA9IHBhZ2VEaXYucXVlcnlTZWxlY3RvcihcIi50ZW1wLWhpZ2hsaWdodHMtbGF5ZXJcIik7XG4gICAgaWYgKCF0ZW1wTGF5ZXIpIHtcbiAgICAgIHRlbXBMYXllciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICB0ZW1wTGF5ZXIuYWRkQ2xhc3MoXCJ0ZW1wLWhpZ2hsaWdodHMtbGF5ZXJcIik7XG4gICAgICBwYWdlRGl2LmFwcGVuZENoaWxkKHRlbXBMYXllcik7XG4gICAgfVxuXG4gICAgZm9yIChjb25zdCByIG9mIHJlY3RzKSB7XG4gICAgICBjb25zdCBlbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICBlbC5hZGRDbGFzcyhcInRlbXAtaGlnaGxpZ2h0LXJlY3RcIik7XG4gICAgICBlbC5zZXRDc3NQcm9wcyh7XG4gICAgICAgIGxlZnQ6IGAke3IucExlZnQgKiAxMDB9JWAsXG4gICAgICAgIHRvcDogYCR7ci5wVG9wICogMTAwfSVgLFxuICAgICAgICB3aWR0aDogYCR7ci5wV2lkdGggKiAxMDB9JWAsXG4gICAgICAgIGhlaWdodDogYCR7ci5wSGVpZ2h0ICogMTAwfSVgLFxuICAgICAgICBcImJhY2tncm91bmQtY29sb3JcIjogY29sb3JIZXgsXG4gICAgICAgIG9wYWNpdHk6IG9wYWNpdHlGbG9hdC50b1N0cmluZygpLFxuICAgICAgfSk7XG4gICAgICB0ZW1wTGF5ZXIuYXBwZW5kQ2hpbGQoZWwpO1xuICAgIH1cbiAgfVxuXG4gIHJlbW92ZVRlbXBvcmFyeUNzc092ZXJsYXkoY3Vyc29yUmVjdDogYW55LCBwYWdlTnVtYmVyOiBudW1iZXIpIHtcbiAgICBjb25zdCBjb250YWluZXIgPSB0aGlzLmFwcC53b3Jrc3BhY2UuZ2V0QWN0aXZlVmlld09mVHlwZShWaWV3KT8uY29udGFpbmVyRWw7XG4gICAgaWYgKCFjb250YWluZXIpIHJldHVybjtcblxuICAgIGNvbnN0IHBhZ2VEaXYgPSBjb250YWluZXIucXVlcnlTZWxlY3RvcihcbiAgICAgIGAucGFnZVtkYXRhLXBhZ2UtbnVtYmVyPVwiJHtwYWdlTnVtYmVyfVwiXWAsXG4gICAgKTtcbiAgICBjb25zdCB0ZW1wTGF5ZXIgPSBwYWdlRGl2Py5xdWVyeVNlbGVjdG9yKFwiLnRlbXAtaGlnaGxpZ2h0cy1sYXllclwiKTtcbiAgICBpZiAoIXRlbXBMYXllcikgcmV0dXJuO1xuXG4gICAgZm9yIChjb25zdCBlbCBvZiBBcnJheS5mcm9tKHRlbXBMYXllci5jaGlsZHJlbikgYXMgSFRNTEVsZW1lbnRbXSkge1xuICAgICAgY29uc3QgbCA9IHBhcnNlRmxvYXQoZWwuc3R5bGUubGVmdCkgLyAxMDA7XG4gICAgICBjb25zdCB3ID0gcGFyc2VGbG9hdChlbC5zdHlsZS53aWR0aCkgLyAxMDA7XG4gICAgICBjb25zdCB0ID0gcGFyc2VGbG9hdChlbC5zdHlsZS50b3ApIC8gMTAwO1xuICAgICAgY29uc3QgaCA9IHBhcnNlRmxvYXQoZWwuc3R5bGUuaGVpZ2h0KSAvIDEwMDtcblxuICAgICAgaWYgKFxuICAgICAgICBjdXJzb3JSZWN0LnBMZWZ0IDw9IGwgKyB3ICYmXG4gICAgICAgIGN1cnNvclJlY3QucExlZnQgKyBjdXJzb3JSZWN0LnBXaWR0aCA+PSBsICYmXG4gICAgICAgIGN1cnNvclJlY3QucFRvcCA8PSB0ICsgaCAmJlxuICAgICAgICBjdXJzb3JSZWN0LnBUb3AgKyBjdXJzb3JSZWN0LnBIZWlnaHQgPj0gdFxuICAgICAgKVxuICAgICAgICBlbC5yZW1vdmUoKTtcbiAgICB9XG4gIH1cblxuICByZWluamVjdENzc092ZXJsYXlzKCkge1xuICAgIGNvbnN0IGFjdGl2ZUZpbGUgPSB0aGlzLmFwcC53b3Jrc3BhY2UuZ2V0QWN0aXZlRmlsZSgpO1xuICAgIGlmICghYWN0aXZlRmlsZSB8fCBhY3RpdmVGaWxlLmV4dGVuc2lvbiAhPT0gXCJwZGZcIikgcmV0dXJuO1xuXG4gICAgY29uc3QgcGVuZGluZyA9IHRoaXMucGVuZGluZ0hpZ2hsaWdodHMuZ2V0KGFjdGl2ZUZpbGUucGF0aCk7XG4gICAgaWYgKCFwZW5kaW5nIHx8IHBlbmRpbmcubGVuZ3RoID09PSAwKSByZXR1cm47XG5cbiAgICBjb25zdCBjb250YWluZXIgPSB0aGlzLmFwcC53b3Jrc3BhY2UuZ2V0QWN0aXZlVmlld09mVHlwZShWaWV3KT8uY29udGFpbmVyRWw7XG4gICAgaWYgKCFjb250YWluZXIpIHJldHVybjtcblxuICAgIGNvbnN0IGJ5UGFnZSA9IG5ldyBNYXA8bnVtYmVyLCBQZGZIaWdobGlnaHRQYXlsb2FkW10+KCk7XG4gICAgZm9yIChjb25zdCBwIG9mIHBlbmRpbmcpIHtcbiAgICAgIGNvbnN0IGFyciA9IGJ5UGFnZS5nZXQocC5wYWdlTnVtYmVyKSA/PyBbXTtcbiAgICAgIGFyci5wdXNoKHApO1xuICAgICAgYnlQYWdlLnNldChwLnBhZ2VOdW1iZXIsIGFycik7XG4gICAgfVxuXG4gICAgZm9yIChjb25zdCBbcGFnZU51bWJlciwgaGlnaGxpZ2h0c10gb2YgYnlQYWdlLmVudHJpZXMoKSkge1xuICAgICAgY29uc3QgcGFnZURpdiA9IGNvbnRhaW5lci5xdWVyeVNlbGVjdG9yKFxuICAgICAgICBgLnBhZ2VbZGF0YS1wYWdlLW51bWJlcj1cIiR7cGFnZU51bWJlcn1cIl1gLFxuICAgICAgKTtcbiAgICAgIGlmICghcGFnZURpdiB8fCBwYWdlRGl2LnF1ZXJ5U2VsZWN0b3IoXCIudGVtcC1oaWdobGlnaHRzLWxheWVyXCIpKSBjb250aW51ZTtcbiAgICAgIGZvciAoY29uc3QgaGwgb2YgaGlnaGxpZ2h0cykge1xuICAgICAgICBjb25zdCBjc3NDb2xvciA9IGByZ2IoJHtNYXRoLnJvdW5kKGhsLmNvbG9yUmdiWzBdICogMjU1KX0sICR7TWF0aC5yb3VuZChobC5jb2xvclJnYlsxXSAqIDI1NSl9LCAke01hdGgucm91bmQoaGwuY29sb3JSZ2JbMl0gKiAyNTUpfSlgO1xuICAgICAgICB0aGlzLmRyYXdUZW1wb3JhcnlDc3NPdmVybGF5KFxuICAgICAgICAgIGhsLnBhZ2VOdW1iZXIsXG4gICAgICAgICAgaGwucmVjdHMsXG4gICAgICAgICAgY3NzQ29sb3IsXG4gICAgICAgICAgaGwub3BhY2l0eSxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBjaGVja0ludGVyc2VjdGlvbihcbiAgICBobFBhZ2U6IG51bWJlcixcbiAgICBobFJlY3RzOiBSZWN0T3ZlcmxheVtdLFxuICAgIGN1cnNvclBhZ2U6IG51bWJlcixcbiAgICBjdXJzb3JSZWN0OiBSZWN0T3ZlcmxheSxcbiAgKTogYm9vbGVhbiB7XG4gICAgaWYgKGhsUGFnZSAhPT0gY3Vyc29yUGFnZSkgcmV0dXJuIGZhbHNlO1xuICAgIGNvbnN0IG1hcmdpbiA9IDAuMDA1O1xuICAgIGZvciAoY29uc3QgciBvZiBobFJlY3RzKSB7XG4gICAgICBpZiAoXG4gICAgICAgIGN1cnNvclJlY3QucExlZnQgPD0gci5wTGVmdCArIHIucFdpZHRoICsgbWFyZ2luICYmXG4gICAgICAgIGN1cnNvclJlY3QucExlZnQgKyBjdXJzb3JSZWN0LnBXaWR0aCA+PSByLnBMZWZ0IC0gbWFyZ2luICYmXG4gICAgICAgIGN1cnNvclJlY3QucFRvcCA8PSByLnBUb3AgKyByLnBIZWlnaHQgKyBtYXJnaW4gJiZcbiAgICAgICAgY3Vyc29yUmVjdC5wVG9wICsgY3Vyc29yUmVjdC5wSGVpZ2h0ID49IHIucFRvcCAtIG1hcmdpblxuICAgICAgKVxuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgb251bmxvYWQoKSB7XG4gICAgdGhpcy5zeW5jUGVuZGluZ1F1ZXVlVG9EaXNrKCkuY2F0Y2goY29uc29sZS5lcnJvcik7XG4gICAgdGhpcy5mbHVzaENhY2hlKCkuY2F0Y2goY29uc29sZS5lcnJvcik7XG4gICAgY29uc29sZS5kZWJ1ZyhcIkFubm90YXRlUERGIGJ5IGJpc2h3YWEgdW5sb2FkZWRcIik7XG4gIH1cblxuICBhc3luYyBsb2FkU2V0dGluZ3MoKSB7XG4gICAgdGhpcy5zZXR0aW5ncyA9IE9iamVjdC5hc3NpZ24oe30sIERFRkFVTFRfU0VUVElOR1MsIGF3YWl0IHRoaXMubG9hZERhdGEoKSk7XG4gIH1cblxuICBhc3luYyBzYXZlU2V0dGluZ3MoKSB7XG4gICAgYXdhaXQgdGhpcy5zYXZlRGF0YSh0aGlzLnNldHRpbmdzKTtcbiAgfVxufVxuXG5jbGFzcyBQZGZIaWdobGlnaHRlclNldHRpbmdUYWIgZXh0ZW5kcyBQbHVnaW5TZXR0aW5nVGFiIHtcbiAgcGx1Z2luOiBQZGZIaWdobGlnaHRlckJpc2h3YWFQbHVnaW47XG5cbiAgY29uc3RydWN0b3IoYXBwOiBBcHAsIHBsdWdpbjogUGRmSGlnaGxpZ2h0ZXJCaXNod2FhUGx1Z2luKSB7XG4gICAgc3VwZXIoYXBwLCBwbHVnaW4pO1xuICAgIHRoaXMucGx1Z2luID0gcGx1Z2luO1xuICB9XG5cbiAgZGlzcGxheSgpOiB2b2lkIHtcbiAgICBjb25zdCB7IGNvbnRhaW5lckVsIH0gPSB0aGlzO1xuICAgIGNvbnRhaW5lckVsLmVtcHR5KCk7XG4gICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG4gICAgICAuc2V0TmFtZShcIkFubm90YXRlUERGIG5hdGl2ZSBzZXR0aW5nc1wiKVxuICAgICAgLnNldEhlYWRpbmcoKTtcblxuICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgLnNldE5hbWUoXCJBdXRob3IgbmFtZVwiKVxuICAgICAgLnNldERlc2MoXCJTdG9yZWQgbmF0aXZlbHkgaW4gdGhlIFBERiBhbm5vdGF0aW9uIG1ldGFkYXRhLlwiKVxuICAgICAgLmFkZFRleHQoKHRleHQpID0+XG4gICAgICAgIHRleHQuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3MuYXV0aG9yKS5vbkNoYW5nZShhc3luYyAodmFsdWUpID0+IHtcbiAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy5hdXRob3IgPSB2YWx1ZTtcbiAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgfSksXG4gICAgICApO1xuXG4gICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG4gICAgICAuc2V0TmFtZShcIlByaW1hcnkgY29sb3IgKGhvdGtleTogaClcIilcbiAgICAgIC5hZGRDb2xvclBpY2tlcigoY29sb3IpID0+XG4gICAgICAgIGNvbG9yXG4gICAgICAgICAgLnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLmhleENvbG9yUHJpbWFyeSlcbiAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XG4gICAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy5oZXhDb2xvclByaW1hcnkgPSB2YWx1ZTtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgIH0pLFxuICAgICAgKTtcblxuICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgLnNldE5hbWUoXCJTZWNvbmRhcnkgY29sb3IgKGhvdGtleTogZylcIilcbiAgICAgIC5hZGRDb2xvclBpY2tlcigoY29sb3IpID0+XG4gICAgICAgIGNvbG9yXG4gICAgICAgICAgLnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLmhleENvbG9yU2Vjb25kYXJ5KVxuICAgICAgICAgIC5vbkNoYW5nZShhc3luYyAodmFsdWUpID0+IHtcbiAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLmhleENvbG9yU2Vjb25kYXJ5ID0gdmFsdWU7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICB9KSxcbiAgICAgICk7XG5cbiAgICBuZXcgU2V0dGluZyhjb250YWluZXJFbClcbiAgICAgIC5zZXROYW1lKFwiVGVydGlhcnkgY29sb3IgKGhvdGtleTogailcIilcbiAgICAgIC5hZGRDb2xvclBpY2tlcigoY29sb3IpID0+XG4gICAgICAgIGNvbG9yXG4gICAgICAgICAgLnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLmhleENvbG9yVGVydGlhcnkpXG4gICAgICAgICAgLm9uQ2hhbmdlKGFzeW5jICh2YWx1ZSkgPT4ge1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3MuaGV4Q29sb3JUZXJ0aWFyeSA9IHZhbHVlO1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgICAgfSksXG4gICAgICApO1xuXG4gICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG4gICAgICAuc2V0TmFtZShcIkhpZ2hsaWdodCBvcGFjaXR5XCIpXG4gICAgICAuc2V0RGVzYyhcIk5hdGl2ZSBQREYgYWxwaGEgb3BhY2l0eSAoMOKAkzEwMCkuXCIpXG4gICAgICAuYWRkU2xpZGVyKChzbGlkZXIpID0+XG4gICAgICAgIHNsaWRlclxuICAgICAgICAgIC5zZXRMaW1pdHMoMCwgMTAwLCAxKVxuICAgICAgICAgIC5zZXRWYWx1ZSh0aGlzLnBsdWdpbi5zZXR0aW5ncy5vcGFjaXR5KVxuICAgICAgICAgIC5zZXREeW5hbWljVG9vbHRpcCgpXG4gICAgICAgICAgLm9uQ2hhbmdlKGFzeW5jICh2YWx1ZSkgPT4ge1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3Mub3BhY2l0eSA9IHZhbHVlO1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgICAgfSksXG4gICAgICApO1xuXG4gICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG4gICAgICAuc2V0TmFtZShcIlJlc2V0IGNhY2hlXCIpXG4gICAgICAuc2V0RGVzYyhcbiAgICAgICAgXCJDbGVhcnMgYWxsIHBlbmRpbmcgcXVldWVzLCB0aGUgSlNPTiBhdWRpdCBsb2csIGFuZCB0aGUgZW5jcnlwdGVkLWZpbGUgYmxvY2tsaXN0LiBcIiArXG4gICAgICAgICAgXCJVc2UgdGhpcyBpZiB5b3UgcmVtb3ZlZCBhIHBhc3N3b3JkIGZyb20gYSBQREYgYW5kIHdhbnQgdG8gYW5ub3RhdGUgaXQgYWdhaW4uXCIsXG4gICAgICApXG4gICAgICAuYWRkQnV0dG9uKChidG4pID0+XG4gICAgICAgIGJ0blxuICAgICAgICAgIC5zZXRCdXR0b25UZXh0KFwiUmVzZXRcIilcbiAgICAgICAgICAuc2V0V2FybmluZygpXG4gICAgICAgICAgLm9uQ2xpY2soYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4ucGVuZGluZ0hpZ2hsaWdodHMuY2xlYXIoKTtcbiAgICAgICAgICAgIHRoaXMucGx1Z2luLnBlbmRpbmdEZWxldGlvbnMuY2xlYXIoKTtcbiAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLnVuZmx1c2hlZEhpZ2hsaWdodHMgPSB7fTtcbiAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLnVuZmx1c2hlZERlbGV0aW9ucyA9IHt9O1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4uX2VuY3J5cHRlZEZpbGVzLmNsZWFyKCk7IC8vIGFsbG93IHJldHJ5aW5nIHByZXZpb3VzbHkgYmxvY2tlZCBmaWxlc1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZURhdGEoeyBmaWxlTWFwOiB7fSB9KTtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgICAgbmV3IE5vdGljZShcIuKchSBDYWNoZSByZXNldC5cIik7XG4gICAgICAgICAgfSksXG4gICAgICApO1xuICB9XG59XG5cbi8vIGJpc2h3YWFiYWJ1XG4iXX0=
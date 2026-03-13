import { __awaiter } from "tslib";
import { Plugin, PluginSettingTab, Setting, Notice, TFile, } from "obsidian";
import { SelectionExtractor } from "./highlight/SelectionExtractor";
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
        // ── Track which files are known-encrypted so we never retry them ────────────
        // This is the key fix for the "continuous error spam" problem.
        // Once we confirm a file is password-protected, we add its path here.
        // The flush loop skips it entirely on every subsequent call.
        // The set is cleared if the user explicitly resets the cache (in case they
        // remove the password and want to retry).
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
            setTimeout(() => this.flushCache(), 3000);
            this.registerInterval(window.setInterval(() => this.reinjectCssOverlays(), 1500));
            this.addCommand({
                id: "highlight-pdf-primary",
                name: "Highlight Selected PDF Text (Primary)",
                checkCallback: (checking) => {
                    var _a;
                    if (((_a = this.app.workspace.activeLeaf) === null || _a === void 0 ? void 0 : _a.view.getViewType()) === "pdf") {
                        if (!checking)
                            this.executeHighlight(this.settings.hexColorPrimary);
                        return true;
                    }
                    return false;
                },
            });
            this.addCommand({
                id: "highlight-pdf-secondary",
                name: "Highlight Selected PDF Text (Secondary)",
                checkCallback: (checking) => {
                    var _a;
                    if (((_a = this.app.workspace.activeLeaf) === null || _a === void 0 ? void 0 : _a.view.getViewType()) === "pdf") {
                        if (!checking)
                            this.executeHighlight(this.settings.hexColorSecondary);
                        return true;
                    }
                    return false;
                },
            });
            this.addCommand({
                id: "highlight-pdf-tertiary",
                name: "Highlight Selected PDF Text (Tertiary)",
                checkCallback: (checking) => {
                    var _a;
                    if (((_a = this.app.workspace.activeLeaf) === null || _a === void 0 ? void 0 : _a.view.getViewType()) === "pdf") {
                        if (!checking)
                            this.executeHighlight(this.settings.hexColorTertiary);
                        return true;
                    }
                    return false;
                },
            });
            this.addCommand({
                id: "remove-pdf-highlight",
                name: "Remove Highlight Under Selection",
                checkCallback: (checking) => {
                    var _a;
                    if (((_a = this.app.workspace.activeLeaf) === null || _a === void 0 ? void 0 : _a.view.getViewType()) === "pdf") {
                        if (!checking)
                            this.executeRemoveHighlight();
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
                    this.executeHighlight(this.settings.hexColorPrimary);
                    evt.preventDefault();
                }
                else if (evt.key.toLowerCase() === "g" && hasSelection) {
                    this.executeHighlight(this.settings.hexColorSecondary);
                    evt.preventDefault();
                }
                else if (evt.key.toLowerCase() === "j" && hasSelection) {
                    this.executeHighlight(this.settings.hexColorTertiary);
                    evt.preventDefault();
                }
                else if ((evt.key === "Delete" || evt.key === "Backspace") &&
                    hasSelection) {
                    this.executeRemoveHighlight();
                    evt.preventDefault();
                }
            });
            this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.flushCache()));
            this.registerEvent(this.app.workspace.on("quit", () => this.flushCache()));
            console.log("AnnotatePDF by bishwaa loaded");
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
                    setTimeout(() => this.flushCache(), 50);
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
                // ── Skip files we already know are encrypted ─────────────────────────
                // This is what stops the infinite error loop. Once a file is confirmed
                // encrypted, we stop retrying it forever. The queue is already cleared
                // at the point of detection (see catch block below), so skipping here
                // is just a safety net for any edge case where paths re-appear.
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
                        // ── Password-protected PDF ────────────────────────────────────────
                        // 1. Show a clear, specific message (not the generic "open elsewhere" message)
                        // 2. CLEAR the queue for this file — retrying is pointless
                        // 3. Mark the file so future flush calls skip it immediately
                        new Notice(`🔒 "${file.name}" is password-protected.\n\nAnnotatePDF cannot modify encrypted PDFs. Highlights have been discarded.`, 8000);
                        // Clear queue so we never retry this file
                        this.pendingHighlights.delete(filePath);
                        this.pendingDeletions.delete(filePath);
                        this._encryptedFiles.add(filePath);
                        yield this.syncPendingQueueToDisk();
                    }
                    else if (e instanceof LockedPdfError) {
                        // ── File locked by another app (Foxit, Acrobat, etc.) ────────────
                        // Keep the queue intact — the user can close the other app and
                        // switch tabs to retry. This is the original resilience behavior.
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
            // ── Guard: refuse to queue highlights for a known-encrypted file ─────────
            // Give instant feedback instead of letting the user highlight happily
            // only to see all their work discarded at flush time.
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
        const container = (_a = this.app.workspace.activeLeaf) === null || _a === void 0 ? void 0 : _a.view.containerEl;
        if (!container)
            return;
        const pageDiv = container.querySelector(`.page[data-page-number="${pageNumber}"]`);
        if (!pageDiv)
            return;
        let tempLayer = pageDiv.querySelector(".temp-highlights-layer");
        if (!tempLayer) {
            tempLayer = document.createElement("div");
            tempLayer.className = "temp-highlights-layer";
            tempLayer.style.cssText =
                "position:absolute;top:0;left:0;width:100%;height:100%;z-index:1;pointer-events:none;";
            pageDiv.appendChild(tempLayer);
        }
        for (const r of rects) {
            const el = document.createElement("div");
            el.style.cssText = `
        position:absolute;
        left:${r.pLeft * 100}%;
        top:${r.pTop * 100}%;
        width:${r.pWidth * 100}%;
        height:${r.pHeight * 100}%;
        background-color:${colorHex};
        opacity:${opacityFloat};
        mix-blend-mode:multiply;
      `;
            tempLayer.appendChild(el);
        }
    }
    removeTemporaryCssOverlay(cursorRect, pageNumber) {
        var _a;
        const container = (_a = this.app.workspace.activeLeaf) === null || _a === void 0 ? void 0 : _a.view.containerEl;
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
        const container = (_a = this.app.workspace.activeLeaf) === null || _a === void 0 ? void 0 : _a.view.containerEl;
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
        console.log("AnnotatePDF by bishwaa unloaded");
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
        containerEl.createEl("h2", { text: "AnnotatePDF Native Settings" });
        new Setting(containerEl)
            .setName("Author Name")
            .setDesc("Stored natively in the PDF annotation metadata.")
            .addText((text) => text.setValue(this.plugin.settings.author).onChange((value) => __awaiter(this, void 0, void 0, function* () {
            this.plugin.settings.author = value;
            yield this.plugin.saveSettings();
        })));
        new Setting(containerEl)
            .setName("Primary Color (Hotkey: h)")
            .addColorPicker((color) => color
            .setValue(this.plugin.settings.hexColorPrimary)
            .onChange((value) => __awaiter(this, void 0, void 0, function* () {
            this.plugin.settings.hexColorPrimary = value;
            yield this.plugin.saveSettings();
        })));
        new Setting(containerEl)
            .setName("Secondary Color (Hotkey: g)")
            .addColorPicker((color) => color
            .setValue(this.plugin.settings.hexColorSecondary)
            .onChange((value) => __awaiter(this, void 0, void 0, function* () {
            this.plugin.settings.hexColorSecondary = value;
            yield this.plugin.saveSettings();
        })));
        new Setting(containerEl)
            .setName("Tertiary Color (Hotkey: j)")
            .addColorPicker((color) => color
            .setValue(this.plugin.settings.hexColorTertiary)
            .onChange((value) => __awaiter(this, void 0, void 0, function* () {
            this.plugin.settings.hexColorTertiary = value;
            yield this.plugin.saveSettings();
        })));
        new Setting(containerEl)
            .setName("Highlight Opacity")
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
            .setName("Reset Cache")
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1haW4udHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBLE9BQU8sRUFFTCxNQUFNLEVBQ04sZ0JBQWdCLEVBQ2hCLE9BQU8sRUFDUCxNQUFNLEVBQ04sS0FBSyxHQUNOLE1BQU0sVUFBVSxDQUFDO0FBQ2xCLE9BQU8sRUFBRSxrQkFBa0IsRUFBRSxNQUFNLGdDQUFnQyxDQUFDO0FBQ3BFLE9BQU8sRUFBRSxrQkFBa0IsRUFBRSxNQUFNLDhCQUE4QixDQUFDO0FBQ2xFLE9BQU8sRUFDTCxZQUFZLEVBRVosaUJBQWlCLEVBQ2pCLGNBQWMsR0FDZixNQUFNLG9CQUFvQixDQUFDO0FBWTVCLE1BQU0sZ0JBQWdCLEdBQTJCO0lBQy9DLGVBQWUsRUFBRSxTQUFTO0lBQzFCLGlCQUFpQixFQUFFLFNBQVM7SUFDNUIsZ0JBQWdCLEVBQUUsU0FBUztJQUMzQixPQUFPLEVBQUUsRUFBRTtJQUNYLE1BQU0sRUFBRSxlQUFlO0lBQ3ZCLG1CQUFtQixFQUFFLEVBQUU7SUFDdkIsa0JBQWtCLEVBQUUsRUFBRTtDQUN2QixDQUFDO0FBRUYsU0FBUyxhQUFhLENBQUMsR0FBVztJQUNoQyxNQUFNLE1BQU0sR0FBRywyQ0FBMkMsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUM7SUFDckUsT0FBTyxNQUFNO1FBQ1gsQ0FBQyxDQUFDO1lBQ0UsUUFBUSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQVcsRUFBRSxFQUFFLENBQUMsR0FBRyxHQUFHO1lBQ3ZDLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFXLEVBQUUsRUFBRSxDQUFDLEdBQUcsR0FBRztZQUN2QyxRQUFRLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBVyxFQUFFLEVBQUUsQ0FBQyxHQUFHLEdBQUc7U0FDeEM7UUFDSCxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDO0FBQ2hCLENBQUM7QUFFRCxNQUFNLENB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InNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7XG4gIEFwcCxcbiAgUGx1Z2luLFxuICBQbHVnaW5TZXR0aW5nVGFiLFxuICBTZXR0aW5nLFxuICBOb3RpY2UsXG4gIFRGaWxlLFxufSBmcm9tIFwib2JzaWRpYW5cIjtcbmltcG9ydCB7IFNlbGVjdGlvbkV4dHJhY3RvciB9IGZyb20gXCIuL2hpZ2hsaWdodC9TZWxlY3Rpb25FeHRyYWN0b3JcIjtcbmltcG9ydCB7IEhpZ2hsaWdodEpzb25TdG9yZSB9IGZyb20gXCIuL3N0b3JhZ2UvSGlnaGxpZ2h0SnNvblN0b3JlXCI7XG5pbXBvcnQge1xuICBQZGZBbm5vdGF0b3IsXG4gIFBkZkhpZ2hsaWdodFBheWxvYWQsXG4gIEVuY3J5cHRlZFBkZkVycm9yLFxuICBMb2NrZWRQZGZFcnJvcixcbn0gZnJvbSBcIi4vcGRmL1BkZkFubm90YXRvclwiO1xuXG5leHBvcnQgaW50ZXJmYWNlIFBkZkhpZ2hsaWdodGVyU2V0dGluZ3Mge1xuICBoZXhDb2xvclByaW1hcnk6IHN0cmluZztcbiAgaGV4Q29sb3JTZWNvbmRhcnk6IHN0cmluZztcbiAgaGV4Q29sb3JUZXJ0aWFyeTogc3RyaW5nO1xuICBvcGFjaXR5OiBudW1iZXI7XG4gIGF1dGhvcjogc3RyaW5nO1xuICB1bmZsdXNoZWRIaWdobGlnaHRzOiBSZWNvcmQ8c3RyaW5nLCBQZGZIaWdobGlnaHRQYXlsb2FkW10+O1xuICB1bmZsdXNoZWREZWxldGlvbnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZ1tdPjtcbn1cblxuY29uc3QgREVGQVVMVF9TRVRUSU5HUzogUGRmSGlnaGxpZ2h0ZXJTZXR0aW5ncyA9IHtcbiAgaGV4Q29sb3JQcmltYXJ5OiBcIiNmZmZmMDBcIixcbiAgaGV4Q29sb3JTZWNvbmRhcnk6IFwiIzAwZmYwMFwiLFxuICBoZXhDb2xvclRlcnRpYXJ5OiBcIiMwMGZmZmZcIixcbiAgb3BhY2l0eTogNDAsXG4gIGF1dGhvcjogXCJPYnNpZGlhbiBVc2VyXCIsXG4gIHVuZmx1c2hlZEhpZ2hsaWdodHM6IHt9LFxuICB1bmZsdXNoZWREZWxldGlvbnM6IHt9LFxufTtcblxuZnVuY3Rpb24gaGV4VG9SZ2JBcnJheShoZXg6IHN0cmluZyk6IFtudW1iZXIsIG51bWJlciwgbnVtYmVyXSB7XG4gIGNvbnN0IHJlc3VsdCA9IC9eIz8oW2EtZlxcZF17Mn0pKFthLWZcXGRdezJ9KShbYS1mXFxkXXsyfSkkL2kuZXhlYyhoZXgpO1xuICByZXR1cm4gcmVzdWx0XG4gICAgPyBbXG4gICAgICAgIHBhcnNlSW50KHJlc3VsdFsxXSBhcyBzdHJpbmcsIDE2KSAvIDI1NSxcbiAgICAgICAgcGFyc2VJbnQocmVzdWx0WzJdIGFzIHN0cmluZywgMTYpIC8gMjU1LFxuICAgICAgICBwYXJzZUludChyZXN1bHRbM10gYXMgc3RyaW5nLCAxNikgLyAyNTUsXG4gICAgICBdXG4gICAgOiBbMSwgMSwgMF07XG59XG5cbmV4cG9ydCBkZWZhdWx0IGNsYXNzIFBkZkhpZ2hsaWdodGVyQmlzaHdhYVBsdWdpbiBleHRlbmRzIFBsdWdpbiB7XG4gIHNldHRpbmdzOiBQZGZIaWdobGlnaHRlclNldHRpbmdzO1xuICBzZWxlY3Rpb25FeHRyYWN0b3I6IFNlbGVjdGlvbkV4dHJhY3RvcjtcbiAgaGlnaGxpZ2h0U3RvcmU6IEhpZ2hsaWdodEpzb25TdG9yZTtcbiAgcGRmQW5ub3RhdG9yOiBQZGZBbm5vdGF0b3I7XG5cbiAgcGVuZGluZ0hpZ2hsaWdodHM6IE1hcDxzdHJpbmcsIFBkZkhpZ2hsaWdodFBheWxvYWRbXT4gPSBuZXcgTWFwKCk7XG4gIHBlbmRpbmdEZWxldGlvbnM6IE1hcDxzdHJpbmcsIHN0cmluZ1tdPiA9IG5ldyBNYXAoKTtcblxuICAvLyBDb25jdXJyZW5jeSBndWFyZFxuICBwcml2YXRlIF9pc0ZsdXNoaW5nID0gZmFsc2U7XG4gIHByaXZhdGUgX2ZsdXNoUGVuZGluZyA9IGZhbHNlO1xuXG4gIC8vIOKUgOKUgCBUcmFjayB3aGljaCBmaWxlcyBhcmUga25vd24tZW5jcnlwdGVkIHNvIHdlIG5ldmVyIHJldHJ5IHRoZW0g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8vIFRoaXMgaXMgdGhlIGtleSBmaXggZm9yIHRoZSBcImNvbnRpbnVvdXMgZXJyb3Igc3BhbVwiIHByb2JsZW0uXG4gIC8vIE9uY2Ugd2UgY29uZmlybSBhIGZpbGUgaXMgcGFzc3dvcmQtcHJvdGVjdGVkLCB3ZSBhZGQgaXRzIHBhdGggaGVyZS5cbiAgLy8gVGhlIGZsdXNoIGxvb3Agc2tpcHMgaXQgZW50aXJlbHkgb24gZXZlcnkgc3Vic2VxdWVudCBjYWxsLlxuICAvLyBUaGUgc2V0IGlzIGNsZWFyZWQgaWYgdGhlIHVzZXIgZXhwbGljaXRseSByZXNldHMgdGhlIGNhY2hlIChpbiBjYXNlIHRoZXlcbiAgLy8gcmVtb3ZlIHRoZSBwYXNzd29yZCBhbmQgd2FudCB0byByZXRyeSkuXG4gIHB1YmxpYyBfZW5jcnlwdGVkRmlsZXM6IFNldDxzdHJpbmc+ID0gbmV3IFNldCgpO1xuXG4gIGFzeW5jIG9ubG9hZCgpIHtcbiAgICBhd2FpdCB0aGlzLmxvYWRTZXR0aW5ncygpO1xuXG4gICAgaWYgKHRoaXMuc2V0dGluZ3MudW5mbHVzaGVkSGlnaGxpZ2h0cykge1xuICAgICAgZm9yIChjb25zdCBbaywgdl0gb2YgT2JqZWN0LmVudHJpZXModGhpcy5zZXR0aW5ncy51bmZsdXNoZWRIaWdobGlnaHRzKSkge1xuICAgICAgICB0aGlzLnBlbmRpbmdIaWdobGlnaHRzLnNldChrLCB2KTtcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKHRoaXMuc2V0dGluZ3MudW5mbHVzaGVkRGVsZXRpb25zKSB7XG4gICAgICBmb3IgKGNvbnN0IFtrLCB2XSBvZiBPYmplY3QuZW50cmllcyh0aGlzLnNldHRpbmdzLnVuZmx1c2hlZERlbGV0aW9ucykpIHtcbiAgICAgICAgdGhpcy5wZW5kaW5nRGVsZXRpb25zLnNldChrLCB2KTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICB0aGlzLmhpZ2hsaWdodFN0b3JlID0gbmV3IEhpZ2hsaWdodEpzb25TdG9yZSh0aGlzKTtcbiAgICB0aGlzLnNlbGVjdGlvbkV4dHJhY3RvciA9IG5ldyBTZWxlY3Rpb25FeHRyYWN0b3IoKTtcbiAgICB0aGlzLnBkZkFubm90YXRvciA9IG5ldyBQZGZBbm5vdGF0b3IodGhpcy5hcHApO1xuXG4gICAgdGhpcy5hZGRTZXR0aW5nVGFiKG5ldyBQZGZIaWdobGlnaHRlclNldHRpbmdUYWIodGhpcy5hcHAsIHRoaXMpKTtcblxuICAgIHNldFRpbWVvdXQoKCkgPT4gdGhpcy5mbHVzaENhY2hlKCksIDMwMDApO1xuXG4gICAgdGhpcy5yZWdpc3RlckludGVydmFsKFxuICAgICAgd2luZG93LnNldEludGVydmFsKCgpID0+IHRoaXMucmVpbmplY3RDc3NPdmVybGF5cygpLCAxNTAwKSxcbiAgICApO1xuXG4gICAgdGhpcy5hZGRDb21tYW5kKHtcbiAgICAgIGlkOiBcImhpZ2hsaWdodC1wZGYtcHJpbWFyeVwiLFxuICAgICAgbmFtZTogXCJIaWdobGlnaHQgU2VsZWN0ZWQgUERGIFRleHQgKFByaW1hcnkpXCIsXG4gICAgICBjaGVja0NhbGxiYWNrOiAoY2hlY2tpbmcpID0+IHtcbiAgICAgICAgaWYgKHRoaXMuYXBwLndvcmtzcGFjZS5hY3RpdmVMZWFmPy52aWV3LmdldFZpZXdUeXBlKCkgPT09IFwicGRmXCIpIHtcbiAgICAgICAgICBpZiAoIWNoZWNraW5nKSB0aGlzLmV4ZWN1dGVIaWdobGlnaHQodGhpcy5zZXR0aW5ncy5oZXhDb2xvclByaW1hcnkpO1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICB0aGlzLmFkZENvbW1hbmQoe1xuICAgICAgaWQ6IFwiaGlnaGxpZ2h0LXBkZi1zZWNvbmRhcnlcIixcbiAgICAgIG5hbWU6IFwiSGlnaGxpZ2h0IFNlbGVjdGVkIFBERiBUZXh0IChTZWNvbmRhcnkpXCIsXG4gICAgICBjaGVja0NhbGxiYWNrOiAoY2hlY2tpbmcpID0+IHtcbiAgICAgICAgaWYgKHRoaXMuYXBwLndvcmtzcGFjZS5hY3RpdmVMZWFmPy52aWV3LmdldFZpZXdUeXBlKCkgPT09IFwicGRmXCIpIHtcbiAgICAgICAgICBpZiAoIWNoZWNraW5nKSB0aGlzLmV4ZWN1dGVIaWdobGlnaHQodGhpcy5zZXR0aW5ncy5oZXhDb2xvclNlY29uZGFyeSk7XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgfSxcbiAgICB9KTtcblxuICAgIHRoaXMuYWRkQ29tbWFuZCh7XG4gICAgICBpZDogXCJoaWdobGlnaHQtcGRmLXRlcnRpYXJ5XCIsXG4gICAgICBuYW1lOiBcIkhpZ2hsaWdodCBTZWxlY3RlZCBQREYgVGV4dCAoVGVydGlhcnkpXCIsXG4gICAgICBjaGVja0NhbGxiYWNrOiAoY2hlY2tpbmcpID0+IHtcbiAgICAgICAgaWYgKHRoaXMuYXBwLndvcmtzcGFjZS5hY3RpdmVMZWFmPy52aWV3LmdldFZpZXdUeXBlKCkgPT09IFwicGRmXCIpIHtcbiAgICAgICAgICBpZiAoIWNoZWNraW5nKSB0aGlzLmV4ZWN1dGVIaWdobGlnaHQodGhpcy5zZXR0aW5ncy5oZXhDb2xvclRlcnRpYXJ5KTtcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgdGhpcy5hZGRDb21tYW5kKHtcbiAgICAgIGlkOiBcInJlbW92ZS1wZGYtaGlnaGxpZ2h0XCIsXG4gICAgICBuYW1lOiBcIlJlbW92ZSBIaWdobGlnaHQgVW5kZXIgU2VsZWN0aW9uXCIsXG4gICAgICBjaGVja0NhbGxiYWNrOiAoY2hlY2tpbmcpID0+IHtcbiAgICAgICAgaWYgKHRoaXMuYXBwLndvcmtzcGFjZS5hY3RpdmVMZWFmPy52aWV3LmdldFZpZXdUeXBlKCkgPT09IFwicGRmXCIpIHtcbiAgICAgICAgICBpZiAoIWNoZWNraW5nKSB0aGlzLmV4ZWN1dGVSZW1vdmVIaWdobGlnaHQoKTtcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgdGhpcy5yZWdpc3RlckRvbUV2ZW50KGRvY3VtZW50LCBcImtleWRvd25cIiwgKGV2dDogS2V5Ym9hcmRFdmVudCkgPT4ge1xuICAgICAgaWYgKHRoaXMuYXBwLndvcmtzcGFjZS5hY3RpdmVMZWFmPy52aWV3LmdldFZpZXdUeXBlKCkgIT09IFwicGRmXCIpIHJldHVybjtcblxuICAgICAgY29uc3QgdGFyZ2V0ID0gZXZ0LnRhcmdldCBhcyBIVE1MRWxlbWVudDtcbiAgICAgIGlmIChcbiAgICAgICAgdGFyZ2V0Py50YWdOYW1lID09PSBcIklOUFVUXCIgfHxcbiAgICAgICAgdGFyZ2V0Py50YWdOYW1lID09PSBcIlRFWFRBUkVBXCIgfHxcbiAgICAgICAgdGFyZ2V0Py5pc0NvbnRlbnRFZGl0YWJsZVxuICAgICAgKVxuICAgICAgICByZXR1cm47XG5cbiAgICAgIGNvbnN0IHNlbGVjdGlvbiA9IHdpbmRvdy5nZXRTZWxlY3Rpb24oKTtcbiAgICAgIGNvbnN0IGhhc1NlbGVjdGlvbiA9XG4gICAgICAgIHNlbGVjdGlvbiAmJlxuICAgICAgICAhc2VsZWN0aW9uLmlzQ29sbGFwc2VkICYmXG4gICAgICAgIHNlbGVjdGlvbi50b1N0cmluZygpLnRyaW0oKS5sZW5ndGggPiAwO1xuXG4gICAgICBpZiAoZXZ0LmtleS50b0xvd2VyQ2FzZSgpID09PSBcImhcIiAmJiBoYXNTZWxlY3Rpb24pIHtcbiAgICAgICAgdGhpcy5leGVjdXRlSGlnaGxpZ2h0KHRoaXMuc2V0dGluZ3MuaGV4Q29sb3JQcmltYXJ5KTtcbiAgICAgICAgZXZ0LnByZXZlbnREZWZhdWx0KCk7XG4gICAgICB9IGVsc2UgaWYgKGV2dC5rZXkudG9Mb3dlckNhc2UoKSA9PT0gXCJnXCIgJiYgaGFzU2VsZWN0aW9uKSB7XG4gICAgICAgIHRoaXMuZXhlY3V0ZUhpZ2hsaWdodCh0aGlzLnNldHRpbmdzLmhleENvbG9yU2Vjb25kYXJ5KTtcbiAgICAgICAgZXZ0LnByZXZlbnREZWZhdWx0KCk7XG4gICAgICB9IGVsc2UgaWYgKGV2dC5rZXkudG9Mb3dlckNhc2UoKSA9PT0gXCJqXCIgJiYgaGFzU2VsZWN0aW9uKSB7XG4gICAgICAgIHRoaXMuZXhlY3V0ZUhpZ2hsaWdodCh0aGlzLnNldHRpbmdzLmhleENvbG9yVGVydGlhcnkpO1xuICAgICAgICBldnQucHJldmVudERlZmF1bHQoKTtcbiAgICAgIH0gZWxzZSBpZiAoXG4gICAgICAgIChldnQua2V5ID09PSBcIkRlbGV0ZVwiIHx8IGV2dC5rZXkgPT09IFwiQmFja3NwYWNlXCIpICYmXG4gICAgICAgIGhhc1NlbGVjdGlvblxuICAgICAgKSB7XG4gICAgICAgIHRoaXMuZXhlY3V0ZVJlbW92ZUhpZ2hsaWdodCgpO1xuICAgICAgICBldnQucHJldmVudERlZmF1bHQoKTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIHRoaXMucmVnaXN0ZXJFdmVudChcbiAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS5vbihcImFjdGl2ZS1sZWFmLWNoYW5nZVwiLCAoKSA9PiB0aGlzLmZsdXNoQ2FjaGUoKSksXG4gICAgKTtcbiAgICB0aGlzLnJlZ2lzdGVyRXZlbnQodGhpcy5hcHAud29ya3NwYWNlLm9uKFwicXVpdFwiLCAoKSA9PiB0aGlzLmZsdXNoQ2FjaGUoKSkpO1xuXG4gICAgY29uc29sZS5sb2coXCJBbm5vdGF0ZVBERiBieSBiaXNod2FhIGxvYWRlZFwiKTtcbiAgfVxuXG4gIC8vIOKUgOKUgOKUgCBDb25jdXJyZW5jeS1zYWZlIGZsdXNoIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICBhc3luYyBmbHVzaENhY2hlKCkge1xuICAgIGlmICh0aGlzLl9pc0ZsdXNoaW5nKSB7XG4gICAgICB0aGlzLl9mbHVzaFBlbmRpbmcgPSB0cnVlO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB0aGlzLl9pc0ZsdXNoaW5nID0gdHJ1ZTtcbiAgICB0aGlzLl9mbHVzaFBlbmRpbmcgPSBmYWxzZTtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgdGhpcy5fZG9GbHVzaCgpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICB0aGlzLl9pc0ZsdXNoaW5nID0gZmFsc2U7XG4gICAgICBpZiAodGhpcy5fZmx1c2hQZW5kaW5nKSB7XG4gICAgICAgIHRoaXMuX2ZsdXNoUGVuZGluZyA9IGZhbHNlO1xuICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHRoaXMuZmx1c2hDYWNoZSgpLCA1MCk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBfZG9GbHVzaCgpIHtcbiAgICBpZiAodGhpcy5wZW5kaW5nSGlnaGxpZ2h0cy5zaXplID09PSAwICYmIHRoaXMucGVuZGluZ0RlbGV0aW9ucy5zaXplID09PSAwKVxuICAgICAgcmV0dXJuO1xuXG4gICAgY29uc3QgaGlnaGxpZ2h0c1RvUHJvY2VzcyA9IG5ldyBNYXAodGhpcy5wZW5kaW5nSGlnaGxpZ2h0cyk7XG4gICAgY29uc3QgZGVsZXRpb25zVG9Qcm9jZXNzID0gbmV3IE1hcCh0aGlzLnBlbmRpbmdEZWxldGlvbnMpO1xuXG4gICAgY29uc3QgYWxsUGF0aHMgPSBuZXcgU2V0KFtcbiAgICAgIC4uLmhpZ2hsaWdodHNUb1Byb2Nlc3Mua2V5cygpLFxuICAgICAgLi4uZGVsZXRpb25zVG9Qcm9jZXNzLmtleXMoKSxcbiAgICBdKTtcblxuICAgIGZvciAoY29uc3QgZmlsZVBhdGggb2YgYWxsUGF0aHMpIHtcbiAgICAgIC8vIOKUgOKUgCBTa2lwIGZpbGVzIHdlIGFscmVhZHkga25vdyBhcmUgZW5jcnlwdGVkIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAgICAgLy8gVGhpcyBpcyB3aGF0IHN0b3BzIHRoZSBpbmZpbml0ZSBlcnJvciBsb29wLiBPbmNlIGEgZmlsZSBpcyBjb25maXJtZWRcbiAgICAgIC8vIGVuY3J5cHRlZCwgd2Ugc3RvcCByZXRyeWluZyBpdCBmb3JldmVyLiBUaGUgcXVldWUgaXMgYWxyZWFkeSBjbGVhcmVkXG4gICAgICAvLyBhdCB0aGUgcG9pbnQgb2YgZGV0ZWN0aW9uIChzZWUgY2F0Y2ggYmxvY2sgYmVsb3cpLCBzbyBza2lwcGluZyBoZXJlXG4gICAgICAvLyBpcyBqdXN0IGEgc2FmZXR5IG5ldCBmb3IgYW55IGVkZ2UgY2FzZSB3aGVyZSBwYXRocyByZS1hcHBlYXIuXG4gICAgICBpZiAodGhpcy5fZW5jcnlwdGVkRmlsZXMuaGFzKGZpbGVQYXRoKSkgY29udGludWU7XG5cbiAgICAgIGNvbnN0IGZpbGUgPSB0aGlzLmFwcC52YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgoZmlsZVBhdGgpO1xuICAgICAgaWYgKCEoZmlsZSBpbnN0YW5jZW9mIFRGaWxlKSkgY29udGludWU7XG5cbiAgICAgIGNvbnN0IGhpZ2hsaWdodHMgPSBoaWdobGlnaHRzVG9Qcm9jZXNzLmdldChmaWxlUGF0aCkgPz8gW107XG4gICAgICBjb25zdCBkZWxldGlvbnMgPSBkZWxldGlvbnNUb1Byb2Nlc3MuZ2V0KGZpbGVQYXRoKSA/PyBbXTtcbiAgICAgIGlmIChoaWdobGlnaHRzLmxlbmd0aCA9PT0gMCAmJiBkZWxldGlvbnMubGVuZ3RoID09PSAwKSBjb250aW51ZTtcblxuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgdGhpcy5wZGZBbm5vdGF0b3IuYXBwbHlCYXRjaFVwZGF0ZXNUb1BkZihcbiAgICAgICAgICBmaWxlLFxuICAgICAgICAgIGhpZ2hsaWdodHMsXG4gICAgICAgICAgZGVsZXRpb25zLFxuICAgICAgICApO1xuXG4gICAgICAgIGNvbnN0IGJ1bGtKc29uRWxlbWVudHMgPSBoaWdobGlnaHRzLm1hcCgocCkgPT4gKHtcbiAgICAgICAgICBpZDogcC5pZCxcbiAgICAgICAgICBwYWdlOiBwLnBhZ2VOdW1iZXIsXG4gICAgICAgICAgcmVjdHM6IHAucmVjdHMsXG4gICAgICAgICAgdGV4dDogXCJCdWxrIEFubm90YXRlZCBEYXRhXCIsXG4gICAgICAgICAgY29sb3I6IGByZ2IoJHtNYXRoLnJvdW5kKHAuY29sb3JSZ2JbMF0gKiAyNTUpfSwgJHtNYXRoLnJvdW5kKHAuY29sb3JSZ2JbMV0gKiAyNTUpfSwgJHtNYXRoLnJvdW5kKHAuY29sb3JSZ2JbMl0gKiAyNTUpfSlgLFxuICAgICAgICAgIG9wYWNpdHk6IHAub3BhY2l0eSxcbiAgICAgICAgICBhdXRob3I6IHAuYXV0aG9yLFxuICAgICAgICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcbiAgICAgICAgfSkpO1xuICAgICAgICBjb25zdCBleGFjdElkc1RvRGVsZXRlID0gZGVsZXRpb25zLmZpbHRlcihcbiAgICAgICAgICAoaWQpID0+ICFpZC5zdGFydHNXaXRoKFwiU1BBVElBTDpcIiksXG4gICAgICAgICk7XG4gICAgICAgIGF3YWl0IHRoaXMuaGlnaGxpZ2h0U3RvcmUuYXBwbHlCYXRjaFVwZGF0ZXNUb0pzb24oXG4gICAgICAgICAgZmlsZVBhdGgsXG4gICAgICAgICAgYnVsa0pzb25FbGVtZW50cyxcbiAgICAgICAgICBleGFjdElkc1RvRGVsZXRlLFxuICAgICAgICApO1xuXG4gICAgICAgIHRoaXMucGVuZGluZ0hpZ2hsaWdodHMuZGVsZXRlKGZpbGVQYXRoKTtcbiAgICAgICAgdGhpcy5wZW5kaW5nRGVsZXRpb25zLmRlbGV0ZShmaWxlUGF0aCk7XG4gICAgICAgIGF3YWl0IHRoaXMuc3luY1BlbmRpbmdRdWV1ZVRvRGlzaygpO1xuXG4gICAgICAgIGlmIChoaWdobGlnaHRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICBuZXcgTm90aWNlKGDinIUgSGlnaGxpZ2h0cyBzYXZlZCB0byAke2ZpbGUubmFtZX1gKTtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBpZiAoZSBpbnN0YW5jZW9mIEVuY3J5cHRlZFBkZkVycm9yKSB7XG4gICAgICAgICAgLy8g4pSA4pSAIFBhc3N3b3JkLXByb3RlY3RlZCBQREYg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gICAgICAgICAgLy8gMS4gU2hvdyBhIGNsZWFyLCBzcGVjaWZpYyBtZXNzYWdlIChub3QgdGhlIGdlbmVyaWMgXCJvcGVuIGVsc2V3aGVyZVwiIG1lc3NhZ2UpXG4gICAgICAgICAgLy8gMi4gQ0xFQVIgdGhlIHF1ZXVlIGZvciB0aGlzIGZpbGUg4oCUIHJldHJ5aW5nIGlzIHBvaW50bGVzc1xuICAgICAgICAgIC8vIDMuIE1hcmsgdGhlIGZpbGUgc28gZnV0dXJlIGZsdXNoIGNhbGxzIHNraXAgaXQgaW1tZWRpYXRlbHlcbiAgICAgICAgICBuZXcgTm90aWNlKFxuICAgICAgICAgICAgYPCflJIgXCIke2ZpbGUubmFtZX1cIiBpcyBwYXNzd29yZC1wcm90ZWN0ZWQuXFxuXFxuQW5ub3RhdGVQREYgY2Fubm90IG1vZGlmeSBlbmNyeXB0ZWQgUERGcy4gSGlnaGxpZ2h0cyBoYXZlIGJlZW4gZGlzY2FyZGVkLmAsXG4gICAgICAgICAgICA4MDAwLFxuICAgICAgICAgICk7XG4gICAgICAgICAgLy8gQ2xlYXIgcXVldWUgc28gd2UgbmV2ZXIgcmV0cnkgdGhpcyBmaWxlXG4gICAgICAgICAgdGhpcy5wZW5kaW5nSGlnaGxpZ2h0cy5kZWxldGUoZmlsZVBhdGgpO1xuICAgICAgICAgIHRoaXMucGVuZGluZ0RlbGV0aW9ucy5kZWxldGUoZmlsZVBhdGgpO1xuICAgICAgICAgIHRoaXMuX2VuY3J5cHRlZEZpbGVzLmFkZChmaWxlUGF0aCk7XG4gICAgICAgICAgYXdhaXQgdGhpcy5zeW5jUGVuZGluZ1F1ZXVlVG9EaXNrKCk7XG4gICAgICAgIH0gZWxzZSBpZiAoZSBpbnN0YW5jZW9mIExvY2tlZFBkZkVycm9yKSB7XG4gICAgICAgICAgLy8g4pSA4pSAIEZpbGUgbG9ja2VkIGJ5IGFub3RoZXIgYXBwIChGb3hpdCwgQWNyb2JhdCwgZXRjLikg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gICAgICAgICAgLy8gS2VlcCB0aGUgcXVldWUgaW50YWN0IOKAlCB0aGUgdXNlciBjYW4gY2xvc2UgdGhlIG90aGVyIGFwcCBhbmRcbiAgICAgICAgICAvLyBzd2l0Y2ggdGFicyB0byByZXRyeS4gVGhpcyBpcyB0aGUgb3JpZ2luYWwgcmVzaWxpZW5jZSBiZWhhdmlvci5cbiAgICAgICAgICBuZXcgTm90aWNlKFxuICAgICAgICAgICAgYOKdjCBcIiR7ZmlsZS5uYW1lfVwiIGlzIG9wZW4gaW4gYW5vdGhlciBhcHAuXFxuXFxuQ2xvc2UgaXQgdGhlcmUgZmlyc3QsIHRoZW4gc3dpdGNoIHRhYnMgdG8gc2F2ZSB5b3VyIGhpZ2hsaWdodHMuYCxcbiAgICAgICAgICAgIDYwMDAsXG4gICAgICAgICAgKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAvLyDilIDilIAgVW5rbm93biBlcnJvciDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgICAgICAgICBuZXcgTm90aWNlKFxuICAgICAgICAgICAgYOKaoO+4jyBGYWlsZWQgdG8gc2F2ZSBoaWdobGlnaHRzIHRvIFwiJHtmaWxlLm5hbWV9XCIuXFxuXFxuQ2hlY2sgdGhlIGRldmVsb3BlciBjb25zb2xlIGZvciBkZXRhaWxzLmAsXG4gICAgICAgICAgICA2MDAwLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zb2xlLmVycm9yKFwiW0Fubm90YXRlUERGXSBGbHVzaCBlcnJvcjpcIiwgZSk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgYXN5bmMgc3luY1BlbmRpbmdRdWV1ZVRvRGlzaygpIHtcbiAgICB0aGlzLnNldHRpbmdzLnVuZmx1c2hlZEhpZ2hsaWdodHMgPSBPYmplY3QuZnJvbUVudHJpZXMoXG4gICAgICB0aGlzLnBlbmRpbmdIaWdobGlnaHRzLFxuICAgICk7XG4gICAgdGhpcy5zZXR0aW5ncy51bmZsdXNoZWREZWxldGlvbnMgPSBPYmplY3QuZnJvbUVudHJpZXMoXG4gICAgICB0aGlzLnBlbmRpbmdEZWxldGlvbnMsXG4gICAgKTtcbiAgICBhd2FpdCB0aGlzLnNhdmVTZXR0aW5ncygpO1xuICB9XG5cbiAgYXN5bmMgZXhlY3V0ZUhpZ2hsaWdodChjb2xvckhleDogc3RyaW5nKSB7XG4gICAgY29uc3QgYWN0aXZlRmlsZSA9IHRoaXMuYXBwLndvcmtzcGFjZS5nZXRBY3RpdmVGaWxlKCk7XG4gICAgaWYgKCFhY3RpdmVGaWxlIHx8IGFjdGl2ZUZpbGUuZXh0ZW5zaW9uICE9PSBcInBkZlwiKSByZXR1cm47XG5cbiAgICAvLyDilIDilIAgR3VhcmQ6IHJlZnVzZSB0byBxdWV1ZSBoaWdobGlnaHRzIGZvciBhIGtub3duLWVuY3J5cHRlZCBmaWxlIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAgIC8vIEdpdmUgaW5zdGFudCBmZWVkYmFjayBpbnN0ZWFkIG9mIGxldHRpbmcgdGhlIHVzZXIgaGlnaGxpZ2h0IGhhcHBpbHlcbiAgICAvLyBvbmx5IHRvIHNlZSBhbGwgdGhlaXIgd29yayBkaXNjYXJkZWQgYXQgZmx1c2ggdGltZS5cbiAgICBpZiAodGhpcy5fZW5jcnlwdGVkRmlsZXMuaGFzKGFjdGl2ZUZpbGUucGF0aCkpIHtcbiAgICAgIG5ldyBOb3RpY2UoXG4gICAgICAgIGDwn5SSIFwiJHthY3RpdmVGaWxlLm5hbWV9XCIgaXMgcGFzc3dvcmQtcHJvdGVjdGVkIGFuZCBjYW5ub3QgYmUgYW5ub3RhdGVkLmAsXG4gICAgICApO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IHNlbGVjdGlvbkRhdGEgPSB0aGlzLnNlbGVjdGlvbkV4dHJhY3Rvci5nZXRBY3RpdmVTZWxlY3Rpb24oKTtcbiAgICBpZiAoIXNlbGVjdGlvbkRhdGEgfHwgc2VsZWN0aW9uRGF0YS5yZWN0cy5sZW5ndGggPT09IDApIHtcbiAgICAgIG5ldyBOb3RpY2UoXCJObyB0ZXh0IHNlbGVjdGVkIHRvIGhpZ2hsaWdodFwiKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCBvcGFjaXR5RmxvYXQgPSB0aGlzLnNldHRpbmdzLm9wYWNpdHkgLyAxMDA7XG4gICAgY29uc3QgY29sb3JBcnJheSA9IGhleFRvUmdiQXJyYXkoY29sb3JIZXgpO1xuICAgIGNvbnN0IGhpZ2hsaWdodElkID0gd2luZG93LmNyeXB0by5yYW5kb21VVUlEKCk7XG5cbiAgICB0aGlzLmRyYXdUZW1wb3JhcnlDc3NPdmVybGF5KFxuICAgICAgc2VsZWN0aW9uRGF0YS5wYWdlTnVtYmVyLFxuICAgICAgc2VsZWN0aW9uRGF0YS5yZWN0cyxcbiAgICAgIGNvbG9ySGV4LFxuICAgICAgb3BhY2l0eUZsb2F0LFxuICAgICk7XG5cbiAgICBjb25zdCBwYXlsb2FkOiBQZGZIaWdobGlnaHRQYXlsb2FkID0ge1xuICAgICAgcGFnZU51bWJlcjogc2VsZWN0aW9uRGF0YS5wYWdlTnVtYmVyLFxuICAgICAgcmVjdHM6IHNlbGVjdGlvbkRhdGEucmVjdHMsXG4gICAgICBjb2xvclJnYjogY29sb3JBcnJheSxcbiAgICAgIG9wYWNpdHk6IG9wYWNpdHlGbG9hdCxcbiAgICAgIGF1dGhvcjogdGhpcy5zZXR0aW5ncy5hdXRob3IsXG4gICAgICBpZDogaGlnaGxpZ2h0SWQsXG4gICAgfTtcblxuICAgIGNvbnN0IGV4aXN0aW5nID0gdGhpcy5wZW5kaW5nSGlnaGxpZ2h0cy5nZXQoYWN0aXZlRmlsZS5wYXRoKSA/PyBbXTtcbiAgICBleGlzdGluZy5wdXNoKHBheWxvYWQpO1xuICAgIHRoaXMucGVuZGluZ0hpZ2hsaWdodHMuc2V0KGFjdGl2ZUZpbGUucGF0aCwgZXhpc3RpbmcpO1xuICAgIGF3YWl0IHRoaXMuc3luY1BlbmRpbmdRdWV1ZVRvRGlzaygpO1xuICAgIHdpbmRvdy5nZXRTZWxlY3Rpb24oKT8uZW1wdHkoKTtcbiAgfVxuXG4gIGFzeW5jIGV4ZWN1dGVSZW1vdmVIaWdobGlnaHQoKSB7XG4gICAgY29uc3QgYWN0aXZlRmlsZSA9IHRoaXMuYXBwLndvcmtzcGFjZS5nZXRBY3RpdmVGaWxlKCk7XG4gICAgaWYgKCFhY3RpdmVGaWxlIHx8IGFjdGl2ZUZpbGUuZXh0ZW5zaW9uICE9PSBcInBkZlwiKSByZXR1cm47XG5cbiAgICBpZiAodGhpcy5fZW5jcnlwdGVkRmlsZXMuaGFzKGFjdGl2ZUZpbGUucGF0aCkpIHtcbiAgICAgIG5ldyBOb3RpY2UoXG4gICAgICAgIGDwn5SSIFwiJHthY3RpdmVGaWxlLm5hbWV9XCIgaXMgcGFzc3dvcmQtcHJvdGVjdGVkIGFuZCBjYW5ub3QgYmUgbW9kaWZpZWQuYCxcbiAgICAgICk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3Qgc2VsZWN0aW9uRGF0YSA9IHRoaXMuc2VsZWN0aW9uRXh0cmFjdG9yLmdldEFjdGl2ZVNlbGVjdGlvbigpO1xuICAgIGlmICghc2VsZWN0aW9uRGF0YSB8fCBzZWxlY3Rpb25EYXRhLnJlY3RzLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuICAgIGNvbnN0IGN1cnNvclJlY3QgPSBzZWxlY3Rpb25EYXRhLnJlY3RzWzBdO1xuICAgIGlmICghY3Vyc29yUmVjdCkgcmV0dXJuO1xuXG4gICAgd2luZG93LmdldFNlbGVjdGlvbigpPy5lbXB0eSgpO1xuXG4gICAgLy8gU3RlcCAxOiBwZW5kaW5nIHF1ZXVlXG4gICAgY29uc3QgcUxpc3QgPSB0aGlzLnBlbmRpbmdIaWdobGlnaHRzLmdldChhY3RpdmVGaWxlLnBhdGgpO1xuICAgIGlmIChxTGlzdCAmJiBxTGlzdC5sZW5ndGggPiAwKSB7XG4gICAgICBjb25zdCBiZWZvcmUgPSBxTGlzdC5sZW5ndGg7XG4gICAgICBjb25zdCBmaWx0ZXJlZCA9IHFMaXN0LmZpbHRlcihcbiAgICAgICAgKHApID0+XG4gICAgICAgICAgIXRoaXMuY2hlY2tJbnRlcnNlY3Rpb24oXG4gICAgICAgICAgICBwLnBhZ2VOdW1iZXIsXG4gICAgICAgICAgICBwLnJlY3RzLFxuICAgICAgICAgICAgc2VsZWN0aW9uRGF0YS5wYWdlTnVtYmVyLFxuICAgICAgICAgICAgY3Vyc29yUmVjdCxcbiAgICAgICAgICApLFxuICAgICAgKTtcbiAgICAgIGlmIChmaWx0ZXJlZC5sZW5ndGggPCBiZWZvcmUpIHtcbiAgICAgICAgdGhpcy5wZW5kaW5nSGlnaGxpZ2h0cy5zZXQoYWN0aXZlRmlsZS5wYXRoLCBmaWx0ZXJlZCk7XG4gICAgICAgIHRoaXMucmVtb3ZlVGVtcG9yYXJ5Q3NzT3ZlcmxheShjdXJzb3JSZWN0LCBzZWxlY3Rpb25EYXRhLnBhZ2VOdW1iZXIpO1xuICAgICAgICBhd2FpdCB0aGlzLnN5bmNQZW5kaW5nUXVldWVUb0Rpc2soKTtcbiAgICAgICAgbmV3IE5vdGljZShcIvCfl5HvuI8gUXVldWVkIGhpZ2hsaWdodCBjYW5jZWxsZWQuXCIpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gU3RlcCAyOiByZWFkIGRpcmVjdGx5IGZyb20gUERGIGJpbmFyeVxuICAgIGxldCBzYXZlZEFubm90YXRpb25zO1xuICAgIHRyeSB7XG4gICAgICBzYXZlZEFubm90YXRpb25zID1cbiAgICAgICAgYXdhaXQgdGhpcy5wZGZBbm5vdGF0b3IucmVhZEFubm90YXRpb25zRnJvbVBkZihhY3RpdmVGaWxlKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBpZiAoZSBpbnN0YW5jZW9mIEVuY3J5cHRlZFBkZkVycm9yKSB7XG4gICAgICAgIHRoaXMuX2VuY3J5cHRlZEZpbGVzLmFkZChhY3RpdmVGaWxlLnBhdGgpO1xuICAgICAgICBuZXcgTm90aWNlKFxuICAgICAgICAgIGDwn5SSIFwiJHthY3RpdmVGaWxlLm5hbWV9XCIgaXMgcGFzc3dvcmQtcHJvdGVjdGVkIGFuZCBjYW5ub3QgYmUgbW9kaWZpZWQuYCxcbiAgICAgICAgKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgbmV3IE5vdGljZShcbiAgICAgICAgYOKaoO+4jyBDb3VsZCBub3QgcmVhZCBcIiR7YWN0aXZlRmlsZS5uYW1lfVwiLiBDaGVjayB0aGUgY29uc29sZSBmb3IgZGV0YWlscy5gLFxuICAgICAgKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAoc2F2ZWRBbm5vdGF0aW9ucy5sZW5ndGggPT09IDApIHtcbiAgICAgIG5ldyBOb3RpY2UoXCLimqDvuI8gTm8gc2F2ZWQgaGlnaGxpZ2h0cyBmb3VuZCBpbiB0aGlzIFBERi5cIik7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgbWFyZ2luID0gMC4wMDU7XG4gICAgY29uc3QgdGFyZ2V0ID0gc2F2ZWRBbm5vdGF0aW9ucy5maW5kKChhbm4pID0+IHtcbiAgICAgIGlmIChhbm4ucGFnZU51bWJlciAhPT0gc2VsZWN0aW9uRGF0YS5wYWdlTnVtYmVyKSByZXR1cm4gZmFsc2U7XG4gICAgICByZXR1cm4gKFxuICAgICAgICBjdXJzb3JSZWN0LnBMZWZ0IDw9IGFubi5wTGVmdCArIGFubi5wV2lkdGggKyBtYXJnaW4gJiZcbiAgICAgICAgY3Vyc29yUmVjdC5wTGVmdCArIGN1cnNvclJlY3QucFdpZHRoID49IGFubi5wTGVmdCAtIG1hcmdpbiAmJlxuICAgICAgICBjdXJzb3JSZWN0LnBUb3AgPD0gYW5uLnBUb3AgKyBhbm4ucEhlaWdodCArIG1hcmdpbiAmJlxuICAgICAgICBjdXJzb3JSZWN0LnBUb3AgKyBjdXJzb3JSZWN0LnBIZWlnaHQgPj0gYW5uLnBUb3AgLSBtYXJnaW5cbiAgICAgICk7XG4gICAgfSk7XG5cbiAgICBpZiAoIXRhcmdldCkge1xuICAgICAgbmV3IE5vdGljZShcIuKaoO+4jyBObyBoaWdobGlnaHQgZm91bmQgYXQgdGhlIHNlbGVjdGVkIHBvc2l0aW9uLlwiKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCBkZWxRID0gdGhpcy5wZW5kaW5nRGVsZXRpb25zLmdldChhY3RpdmVGaWxlLnBhdGgpID8/IFtdO1xuICAgIGlmICh0YXJnZXQuaWQpIGRlbFEucHVzaCh0YXJnZXQuaWQpO1xuICAgIGRlbFEucHVzaChcbiAgICAgIGBTUEFUSUFMOiR7dGFyZ2V0LnBhZ2VOdW1iZXJ9OiR7dGFyZ2V0LnBMZWZ0fSwke3RhcmdldC5wVG9wfSwke3RhcmdldC5wV2lkdGh9LCR7dGFyZ2V0LnBIZWlnaHR9YCxcbiAgICApO1xuICAgIHRoaXMucGVuZGluZ0RlbGV0aW9ucy5zZXQoYWN0aXZlRmlsZS5wYXRoLCBkZWxRKTtcbiAgICBhd2FpdCB0aGlzLnN5bmNQZW5kaW5nUXVldWVUb0Rpc2soKTtcbiAgICBhd2FpdCB0aGlzLmZsdXNoQ2FjaGUoKTtcbiAgfVxuXG4gIC8vIOKUgOKUgOKUgCBDU1Mgb3ZlcmxheSBoZWxwZXJzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICBkcmF3VGVtcG9yYXJ5Q3NzT3ZlcmxheShcbiAgICBwYWdlTnVtYmVyOiBudW1iZXIsXG4gICAgcmVjdHM6IGFueVtdLFxuICAgIGNvbG9ySGV4OiBzdHJpbmcsXG4gICAgb3BhY2l0eUZsb2F0OiBudW1iZXIsXG4gICkge1xuICAgIGNvbnN0IGNvbnRhaW5lciA9IHRoaXMuYXBwLndvcmtzcGFjZS5hY3RpdmVMZWFmPy52aWV3LmNvbnRhaW5lckVsO1xuICAgIGlmICghY29udGFpbmVyKSByZXR1cm47XG5cbiAgICBjb25zdCBwYWdlRGl2ID0gY29udGFpbmVyLnF1ZXJ5U2VsZWN0b3IoXG4gICAgICBgLnBhZ2VbZGF0YS1wYWdlLW51bWJlcj1cIiR7cGFnZU51bWJlcn1cIl1gLFxuICAgICk7XG4gICAgaWYgKCFwYWdlRGl2KSByZXR1cm47XG5cbiAgICBsZXQgdGVtcExheWVyID0gcGFnZURpdi5xdWVyeVNlbGVjdG9yKFwiLnRlbXAtaGlnaGxpZ2h0cy1sYXllclwiKTtcbiAgICBpZiAoIXRlbXBMYXllcikge1xuICAgICAgdGVtcExheWVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgIHRlbXBMYXllci5jbGFzc05hbWUgPSBcInRlbXAtaGlnaGxpZ2h0cy1sYXllclwiO1xuICAgICAgKHRlbXBMYXllciBhcyBIVE1MRWxlbWVudCkuc3R5bGUuY3NzVGV4dCA9XG4gICAgICAgIFwicG9zaXRpb246YWJzb2x1dGU7dG9wOjA7bGVmdDowO3dpZHRoOjEwMCU7aGVpZ2h0OjEwMCU7ei1pbmRleDoxO3BvaW50ZXItZXZlbnRzOm5vbmU7XCI7XG4gICAgICBwYWdlRGl2LmFwcGVuZENoaWxkKHRlbXBMYXllcik7XG4gICAgfVxuXG4gICAgZm9yIChjb25zdCByIG9mIHJlY3RzKSB7XG4gICAgICBjb25zdCBlbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICBlbC5zdHlsZS5jc3NUZXh0ID0gYFxuICAgICAgICBwb3NpdGlvbjphYnNvbHV0ZTtcbiAgICAgICAgbGVmdDoke3IucExlZnQgKiAxMDB9JTtcbiAgICAgICAgdG9wOiR7ci5wVG9wICogMTAwfSU7XG4gICAgICAgIHdpZHRoOiR7ci5wV2lkdGggKiAxMDB9JTtcbiAgICAgICAgaGVpZ2h0OiR7ci5wSGVpZ2h0ICogMTAwfSU7XG4gICAgICAgIGJhY2tncm91bmQtY29sb3I6JHtjb2xvckhleH07XG4gICAgICAgIG9wYWNpdHk6JHtvcGFjaXR5RmxvYXR9O1xuICAgICAgICBtaXgtYmxlbmQtbW9kZTptdWx0aXBseTtcbiAgICAgIGA7XG4gICAgICB0ZW1wTGF5ZXIuYXBwZW5kQ2hpbGQoZWwpO1xuICAgIH1cbiAgfVxuXG4gIHJlbW92ZVRlbXBvcmFyeUNzc092ZXJsYXkoY3Vyc29yUmVjdDogYW55LCBwYWdlTnVtYmVyOiBudW1iZXIpIHtcbiAgICBjb25zdCBjb250YWluZXIgPSB0aGlzLmFwcC53b3Jrc3BhY2UuYWN0aXZlTGVhZj8udmlldy5jb250YWluZXJFbDtcbiAgICBpZiAoIWNvbnRhaW5lcikgcmV0dXJuO1xuXG4gICAgY29uc3QgcGFnZURpdiA9IGNvbnRhaW5lci5xdWVyeVNlbGVjdG9yKFxuICAgICAgYC5wYWdlW2RhdGEtcGFnZS1udW1iZXI9XCIke3BhZ2VOdW1iZXJ9XCJdYCxcbiAgICApO1xuICAgIGNvbnN0IHRlbXBMYXllciA9IHBhZ2VEaXY/LnF1ZXJ5U2VsZWN0b3IoXCIudGVtcC1oaWdobGlnaHRzLWxheWVyXCIpO1xuICAgIGlmICghdGVtcExheWVyKSByZXR1cm47XG5cbiAgICBmb3IgKGNvbnN0IGVsIG9mIEFycmF5LmZyb20odGVtcExheWVyLmNoaWxkcmVuKSBhcyBIVE1MRWxlbWVudFtdKSB7XG4gICAgICBjb25zdCBsID0gcGFyc2VGbG9hdChlbC5zdHlsZS5sZWZ0KSAvIDEwMDtcbiAgICAgIGNvbnN0IHcgPSBwYXJzZUZsb2F0KGVsLnN0eWxlLndpZHRoKSAvIDEwMDtcbiAgICAgIGNvbnN0IHQgPSBwYXJzZUZsb2F0KGVsLnN0eWxlLnRvcCkgLyAxMDA7XG4gICAgICBjb25zdCBoID0gcGFyc2VGbG9hdChlbC5zdHlsZS5oZWlnaHQpIC8gMTAwO1xuXG4gICAgICBpZiAoXG4gICAgICAgIGN1cnNvclJlY3QucExlZnQgPD0gbCArIHcgJiZcbiAgICAgICAgY3Vyc29yUmVjdC5wTGVmdCArIGN1cnNvclJlY3QucFdpZHRoID49IGwgJiZcbiAgICAgICAgY3Vyc29yUmVjdC5wVG9wIDw9IHQgKyBoICYmXG4gICAgICAgIGN1cnNvclJlY3QucFRvcCArIGN1cnNvclJlY3QucEhlaWdodCA+PSB0XG4gICAgICApXG4gICAgICAgIGVsLnJlbW92ZSgpO1xuICAgIH1cbiAgfVxuXG4gIHJlaW5qZWN0Q3NzT3ZlcmxheXMoKSB7XG4gICAgY29uc3QgYWN0aXZlRmlsZSA9IHRoaXMuYXBwLndvcmtzcGFjZS5nZXRBY3RpdmVGaWxlKCk7XG4gICAgaWYgKCFhY3RpdmVGaWxlIHx8IGFjdGl2ZUZpbGUuZXh0ZW5zaW9uICE9PSBcInBkZlwiKSByZXR1cm47XG5cbiAgICBjb25zdCBwZW5kaW5nID0gdGhpcy5wZW5kaW5nSGlnaGxpZ2h0cy5nZXQoYWN0aXZlRmlsZS5wYXRoKTtcbiAgICBpZiAoIXBlbmRpbmcgfHwgcGVuZGluZy5sZW5ndGggPT09IDApIHJldHVybjtcblxuICAgIGNvbnN0IGNvbnRhaW5lciA9IHRoaXMuYXBwLndvcmtzcGFjZS5hY3RpdmVMZWFmPy52aWV3LmNvbnRhaW5lckVsO1xuICAgIGlmICghY29udGFpbmVyKSByZXR1cm47XG5cbiAgICBjb25zdCBieVBhZ2UgPSBuZXcgTWFwPG51bWJlciwgUGRmSGlnaGxpZ2h0UGF5bG9hZFtdPigpO1xuICAgIGZvciAoY29uc3QgcCBvZiBwZW5kaW5nKSB7XG4gICAgICBjb25zdCBhcnIgPSBieVBhZ2UuZ2V0KHAucGFnZU51bWJlcikgPz8gW107XG4gICAgICBhcnIucHVzaChwKTtcbiAgICAgIGJ5UGFnZS5zZXQocC5wYWdlTnVtYmVyLCBhcnIpO1xuICAgIH1cblxuICAgIGZvciAoY29uc3QgW3BhZ2VOdW1iZXIsIGhpZ2hsaWdodHNdIG9mIGJ5UGFnZS5lbnRyaWVzKCkpIHtcbiAgICAgIGNvbnN0IHBhZ2VEaXYgPSBjb250YWluZXIucXVlcnlTZWxlY3RvcihcbiAgICAgICAgYC5wYWdlW2RhdGEtcGFnZS1udW1iZXI9XCIke3BhZ2VOdW1iZXJ9XCJdYCxcbiAgICAgICk7XG4gICAgICBpZiAoIXBhZ2VEaXYgfHwgcGFnZURpdi5xdWVyeVNlbGVjdG9yKFwiLnRlbXAtaGlnaGxpZ2h0cy1sYXllclwiKSkgY29udGludWU7XG4gICAgICBmb3IgKGNvbnN0IGhsIG9mIGhpZ2hsaWdodHMpIHtcbiAgICAgICAgY29uc3QgY3NzQ29sb3IgPSBgcmdiKCR7TWF0aC5yb3VuZChobC5jb2xvclJnYlswXSAqIDI1NSl9LCAke01hdGgucm91bmQoaGwuY29sb3JSZ2JbMV0gKiAyNTUpfSwgJHtNYXRoLnJvdW5kKGhsLmNvbG9yUmdiWzJdICogMjU1KX0pYDtcbiAgICAgICAgdGhpcy5kcmF3VGVtcG9yYXJ5Q3NzT3ZlcmxheShcbiAgICAgICAgICBobC5wYWdlTnVtYmVyLFxuICAgICAgICAgIGhsLnJlY3RzLFxuICAgICAgICAgIGNzc0NvbG9yLFxuICAgICAgICAgIGhsLm9wYWNpdHksXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgY2hlY2tJbnRlcnNlY3Rpb24oXG4gICAgaGxQYWdlOiBudW1iZXIsXG4gICAgaGxSZWN0czogYW55W10sXG4gICAgY3Vyc29yUGFnZTogbnVtYmVyLFxuICAgIGN1cnNvclJlY3Q6IGFueSxcbiAgKTogYm9vbGVhbiB7XG4gICAgaWYgKGhsUGFnZSAhPT0gY3Vyc29yUGFnZSkgcmV0dXJuIGZhbHNlO1xuICAgIGNvbnN0IG1hcmdpbiA9IDAuMDA1O1xuICAgIGZvciAoY29uc3QgciBvZiBobFJlY3RzKSB7XG4gICAgICBpZiAoXG4gICAgICAgIGN1cnNvclJlY3QucExlZnQgPD0gci5wTGVmdCArIHIucFdpZHRoICsgbWFyZ2luICYmXG4gICAgICAgIGN1cnNvclJlY3QucExlZnQgKyBjdXJzb3JSZWN0LnBXaWR0aCA+PSByLnBMZWZ0IC0gbWFyZ2luICYmXG4gICAgICAgIGN1cnNvclJlY3QucFRvcCA8PSByLnBUb3AgKyByLnBIZWlnaHQgKyBtYXJnaW4gJiZcbiAgICAgICAgY3Vyc29yUmVjdC5wVG9wICsgY3Vyc29yUmVjdC5wSGVpZ2h0ID49IHIucFRvcCAtIG1hcmdpblxuICAgICAgKVxuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgb251bmxvYWQoKSB7XG4gICAgdGhpcy5zeW5jUGVuZGluZ1F1ZXVlVG9EaXNrKCkuY2F0Y2goY29uc29sZS5lcnJvcik7XG4gICAgdGhpcy5mbHVzaENhY2hlKCkuY2F0Y2goY29uc29sZS5lcnJvcik7XG4gICAgY29uc29sZS5sb2coXCJBbm5vdGF0ZVBERiBieSBiaXNod2FhIHVubG9hZGVkXCIpO1xuICB9XG5cbiAgYXN5bmMgbG9hZFNldHRpbmdzKCkge1xuICAgIHRoaXMuc2V0dGluZ3MgPSBPYmplY3QuYXNzaWduKHt9LCBERUZBVUxUX1NFVFRJTkdTLCBhd2FpdCB0aGlzLmxvYWREYXRhKCkpO1xuICB9XG5cbiAgYXN5bmMgc2F2ZVNldHRpbmdzKCkge1xuICAgIGF3YWl0IHRoaXMuc2F2ZURhdGEodGhpcy5zZXR0aW5ncyk7XG4gIH1cbn1cblxuY2xhc3MgUGRmSGlnaGxpZ2h0ZXJTZXR0aW5nVGFiIGV4dGVuZHMgUGx1Z2luU2V0dGluZ1RhYiB7XG4gIHBsdWdpbjogUGRmSGlnaGxpZ2h0ZXJCaXNod2FhUGx1Z2luO1xuXG4gIGNvbnN0cnVjdG9yKGFwcDogQXBwLCBwbHVnaW46IFBkZkhpZ2hsaWdodGVyQmlzaHdhYVBsdWdpbikge1xuICAgIHN1cGVyKGFwcCwgcGx1Z2luKTtcbiAgICB0aGlzLnBsdWdpbiA9IHBsdWdpbjtcbiAgfVxuXG4gIGRpc3BsYXkoKTogdm9pZCB7XG4gICAgY29uc3QgeyBjb250YWluZXJFbCB9ID0gdGhpcztcbiAgICBjb250YWluZXJFbC5lbXB0eSgpO1xuICAgIGNvbnRhaW5lckVsLmNyZWF0ZUVsKFwiaDJcIiwgeyB0ZXh0OiBcIkFubm90YXRlUERGIE5hdGl2ZSBTZXR0aW5nc1wiIH0pO1xuXG4gICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG4gICAgICAuc2V0TmFtZShcIkF1dGhvciBOYW1lXCIpXG4gICAgICAuc2V0RGVzYyhcIlN0b3JlZCBuYXRpdmVseSBpbiB0aGUgUERGIGFubm90YXRpb24gbWV0YWRhdGEuXCIpXG4gICAgICAuYWRkVGV4dCgodGV4dCkgPT5cbiAgICAgICAgdGV4dC5zZXRWYWx1ZSh0aGlzLnBsdWdpbi5zZXR0aW5ncy5hdXRob3IpLm9uQ2hhbmdlKGFzeW5jICh2YWx1ZSkgPT4ge1xuICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLmF1dGhvciA9IHZhbHVlO1xuICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICB9KSxcbiAgICAgICk7XG5cbiAgICBuZXcgU2V0dGluZyhjb250YWluZXJFbClcbiAgICAgIC5zZXROYW1lKFwiUHJpbWFyeSBDb2xvciAoSG90a2V5OiBoKVwiKVxuICAgICAgLmFkZENvbG9yUGlja2VyKChjb2xvcikgPT5cbiAgICAgICAgY29sb3JcbiAgICAgICAgICAuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3MuaGV4Q29sb3JQcmltYXJ5KVxuICAgICAgICAgIC5vbkNoYW5nZShhc3luYyAodmFsdWUpID0+IHtcbiAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLmhleENvbG9yUHJpbWFyeSA9IHZhbHVlO1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgICAgfSksXG4gICAgICApO1xuXG4gICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG4gICAgICAuc2V0TmFtZShcIlNlY29uZGFyeSBDb2xvciAoSG90a2V5OiBnKVwiKVxuICAgICAgLmFkZENvbG9yUGlja2VyKChjb2xvcikgPT5cbiAgICAgICAgY29sb3JcbiAgICAgICAgICAuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3MuaGV4Q29sb3JTZWNvbmRhcnkpXG4gICAgICAgICAgLm9uQ2hhbmdlKGFzeW5jICh2YWx1ZSkgPT4ge1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3MuaGV4Q29sb3JTZWNvbmRhcnkgPSB2YWx1ZTtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgIH0pLFxuICAgICAgKTtcblxuICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgLnNldE5hbWUoXCJUZXJ0aWFyeSBDb2xvciAoSG90a2V5OiBqKVwiKVxuICAgICAgLmFkZENvbG9yUGlja2VyKChjb2xvcikgPT5cbiAgICAgICAgY29sb3JcbiAgICAgICAgICAuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3MuaGV4Q29sb3JUZXJ0aWFyeSlcbiAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XG4gICAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy5oZXhDb2xvclRlcnRpYXJ5ID0gdmFsdWU7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICB9KSxcbiAgICAgICk7XG5cbiAgICBuZXcgU2V0dGluZyhjb250YWluZXJFbClcbiAgICAgIC5zZXROYW1lKFwiSGlnaGxpZ2h0IE9wYWNpdHlcIilcbiAgICAgIC5zZXREZXNjKFwiTmF0aXZlIFBERiBhbHBoYSBvcGFjaXR5ICgw4oCTMTAwKS5cIilcbiAgICAgIC5hZGRTbGlkZXIoKHNsaWRlcikgPT5cbiAgICAgICAgc2xpZGVyXG4gICAgICAgICAgLnNldExpbWl0cygwLCAxMDAsIDEpXG4gICAgICAgICAgLnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLm9wYWNpdHkpXG4gICAgICAgICAgLnNldER5bmFtaWNUb29sdGlwKClcbiAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XG4gICAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy5vcGFjaXR5ID0gdmFsdWU7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICB9KSxcbiAgICAgICk7XG5cbiAgICBuZXcgU2V0dGluZyhjb250YWluZXJFbClcbiAgICAgIC5zZXROYW1lKFwiUmVzZXQgQ2FjaGVcIilcbiAgICAgIC5zZXREZXNjKFxuICAgICAgICBcIkNsZWFycyBhbGwgcGVuZGluZyBxdWV1ZXMsIHRoZSBKU09OIGF1ZGl0IGxvZywgYW5kIHRoZSBlbmNyeXB0ZWQtZmlsZSBibG9ja2xpc3QuIFwiICtcbiAgICAgICAgICBcIlVzZSB0aGlzIGlmIHlvdSByZW1vdmVkIGEgcGFzc3dvcmQgZnJvbSBhIFBERiBhbmQgd2FudCB0byBhbm5vdGF0ZSBpdCBhZ2Fpbi5cIixcbiAgICAgIClcbiAgICAgIC5hZGRCdXR0b24oKGJ0bikgPT5cbiAgICAgICAgYnRuXG4gICAgICAgICAgLnNldEJ1dHRvblRleHQoXCJSZXNldFwiKVxuICAgICAgICAgIC5zZXRXYXJuaW5nKClcbiAgICAgICAgICAub25DbGljayhhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICB0aGlzLnBsdWdpbi5wZW5kaW5nSGlnaGxpZ2h0cy5jbGVhcigpO1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4ucGVuZGluZ0RlbGV0aW9ucy5jbGVhcigpO1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3MudW5mbHVzaGVkSGlnaGxpZ2h0cyA9IHt9O1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3MudW5mbHVzaGVkRGVsZXRpb25zID0ge307XG4gICAgICAgICAgICB0aGlzLnBsdWdpbi5fZW5jcnlwdGVkRmlsZXMuY2xlYXIoKTsgLy8gYWxsb3cgcmV0cnlpbmcgcHJldmlvdXNseSBibG9ja2VkIGZpbGVzXG4gICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlRGF0YSh7IGZpbGVNYXA6IHt9IH0pO1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgICAgICBuZXcgTm90aWNlKFwi4pyFIENhY2hlIHJlc2V0LlwiKTtcbiAgICAgICAgICB9KSxcbiAgICAgICk7XG4gIH1cbn1cbiJdfQ==
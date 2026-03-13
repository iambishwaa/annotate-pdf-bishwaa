import {
  App,
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  TFile,
} from "obsidian";
import { SelectionExtractor } from "./highlight/SelectionExtractor";
import { HighlightJsonStore } from "./storage/HighlightJsonStore";
import {
  PdfAnnotator,
  PdfHighlightPayload,
  EncryptedPdfError,
  LockedPdfError,
} from "./pdf/PdfAnnotator";

export interface PdfHighlighterSettings {
  hexColorPrimary: string;
  hexColorSecondary: string;
  hexColorTertiary: string;
  opacity: number;
  author: string;
  unflushedHighlights: Record<string, PdfHighlightPayload[]>;
  unflushedDeletions: Record<string, string[]>;
}

const DEFAULT_SETTINGS: PdfHighlighterSettings = {
  hexColorPrimary: "#ffff00",
  hexColorSecondary: "#00ff00",
  hexColorTertiary: "#00ffff",
  opacity: 40,
  author: "Obsidian User",
  unflushedHighlights: {},
  unflushedDeletions: {},
};

function hexToRgbArray(hex: string): [number, number, number] {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? [
        parseInt(result[1] as string, 16) / 255,
        parseInt(result[2] as string, 16) / 255,
        parseInt(result[3] as string, 16) / 255,
      ]
    : [1, 1, 0];
}

export default class PdfHighlighterBishwaaPlugin extends Plugin {
  settings: PdfHighlighterSettings;
  selectionExtractor: SelectionExtractor;
  highlightStore: HighlightJsonStore;
  pdfAnnotator: PdfAnnotator;

  pendingHighlights: Map<string, PdfHighlightPayload[]> = new Map();
  pendingDeletions: Map<string, string[]> = new Map();

  // Concurrency guard
  private _isFlushing = false;
  private _flushPending = false;

  // ── Track which files are known-encrypted so we never retry them ────────────
  // This is the key fix for the "continuous error spam" problem.
  // Once we confirm a file is password-protected, we add its path here.
  // The flush loop skips it entirely on every subsequent call.
  // The set is cleared if the user explicitly resets the cache (in case they
  // remove the password and want to retry).
  public _encryptedFiles: Set<string> = new Set();

  async onload() {
    await this.loadSettings();

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

    this.registerInterval(
      window.setInterval(() => this.reinjectCssOverlays(), 1500),
    );

    this.addCommand({
      id: "highlight-pdf-primary",
      name: "Highlight Selected PDF Text (Primary)",
      checkCallback: (checking) => {
        if (this.app.workspace.activeLeaf?.view.getViewType() === "pdf") {
          if (!checking) this.executeHighlight(this.settings.hexColorPrimary);
          return true;
        }
        return false;
      },
    });

    this.addCommand({
      id: "highlight-pdf-secondary",
      name: "Highlight Selected PDF Text (Secondary)",
      checkCallback: (checking) => {
        if (this.app.workspace.activeLeaf?.view.getViewType() === "pdf") {
          if (!checking) this.executeHighlight(this.settings.hexColorSecondary);
          return true;
        }
        return false;
      },
    });

    this.addCommand({
      id: "highlight-pdf-tertiary",
      name: "Highlight Selected PDF Text (Tertiary)",
      checkCallback: (checking) => {
        if (this.app.workspace.activeLeaf?.view.getViewType() === "pdf") {
          if (!checking) this.executeHighlight(this.settings.hexColorTertiary);
          return true;
        }
        return false;
      },
    });

    this.addCommand({
      id: "remove-pdf-highlight",
      name: "Remove Highlight Under Selection",
      checkCallback: (checking) => {
        if (this.app.workspace.activeLeaf?.view.getViewType() === "pdf") {
          if (!checking) this.executeRemoveHighlight();
          return true;
        }
        return false;
      },
    });

    this.registerDomEvent(document, "keydown", (evt: KeyboardEvent) => {
      if (this.app.workspace.activeLeaf?.view.getViewType() !== "pdf") return;

      const target = evt.target as HTMLElement;
      if (
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable
      )
        return;

      const selection = window.getSelection();
      const hasSelection =
        selection &&
        !selection.isCollapsed &&
        selection.toString().trim().length > 0;

      if (evt.key.toLowerCase() === "h" && hasSelection) {
        this.executeHighlight(this.settings.hexColorPrimary);
        evt.preventDefault();
      } else if (evt.key.toLowerCase() === "g" && hasSelection) {
        this.executeHighlight(this.settings.hexColorSecondary);
        evt.preventDefault();
      } else if (evt.key.toLowerCase() === "j" && hasSelection) {
        this.executeHighlight(this.settings.hexColorTertiary);
        evt.preventDefault();
      } else if (
        (evt.key === "Delete" || evt.key === "Backspace") &&
        hasSelection
      ) {
        this.executeRemoveHighlight();
        evt.preventDefault();
      }
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.flushCache()),
    );
    this.registerEvent(this.app.workspace.on("quit", () => this.flushCache()));

    console.log("AnnotatePDF by bishwaa loaded");
  }

  // ─── Concurrency-safe flush ───────────────────────────────────────────────
  async flushCache() {
    if (this._isFlushing) {
      this._flushPending = true;
      return;
    }
    this._isFlushing = true;
    this._flushPending = false;
    try {
      await this._doFlush();
    } finally {
      this._isFlushing = false;
      if (this._flushPending) {
        this._flushPending = false;
        setTimeout(() => this.flushCache(), 50);
      }
    }
  }

  private async _doFlush() {
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
      if (this._encryptedFiles.has(filePath)) continue;

      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (!(file instanceof TFile)) continue;

      const highlights = highlightsToProcess.get(filePath) ?? [];
      const deletions = deletionsToProcess.get(filePath) ?? [];
      if (highlights.length === 0 && deletions.length === 0) continue;

      try {
        await this.pdfAnnotator.applyBatchUpdatesToPdf(
          file,
          highlights,
          deletions,
        );

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
        const exactIdsToDelete = deletions.filter(
          (id) => !id.startsWith("SPATIAL:"),
        );
        await this.highlightStore.applyBatchUpdatesToJson(
          filePath,
          bulkJsonElements,
          exactIdsToDelete,
        );

        this.pendingHighlights.delete(filePath);
        this.pendingDeletions.delete(filePath);
        await this.syncPendingQueueToDisk();

        if (highlights.length > 0) {
          new Notice(`✅ Highlights saved to ${file.name}`);
        }
      } catch (e) {
        if (e instanceof EncryptedPdfError) {
          // ── Password-protected PDF ────────────────────────────────────────
          // 1. Show a clear, specific message (not the generic "open elsewhere" message)
          // 2. CLEAR the queue for this file — retrying is pointless
          // 3. Mark the file so future flush calls skip it immediately
          new Notice(
            `🔒 "${file.name}" is password-protected.\n\nAnnotatePDF cannot modify encrypted PDFs. Highlights have been discarded.`,
            8000,
          );
          // Clear queue so we never retry this file
          this.pendingHighlights.delete(filePath);
          this.pendingDeletions.delete(filePath);
          this._encryptedFiles.add(filePath);
          await this.syncPendingQueueToDisk();
        } else if (e instanceof LockedPdfError) {
          // ── File locked by another app (Foxit, Acrobat, etc.) ────────────
          // Keep the queue intact — the user can close the other app and
          // switch tabs to retry. This is the original resilience behavior.
          new Notice(
            `❌ "${file.name}" is open in another app.\n\nClose it there first, then switch tabs to save your highlights.`,
            6000,
          );
        } else {
          // ── Unknown error ─────────────────────────────────────────────────
          new Notice(
            `⚠️ Failed to save highlights to "${file.name}".\n\nCheck the developer console for details.`,
            6000,
          );
        }

        console.error("[AnnotatePDF] Flush error:", e);
      }
    }
  }

  async syncPendingQueueToDisk() {
    this.settings.unflushedHighlights = Object.fromEntries(
      this.pendingHighlights,
    );
    this.settings.unflushedDeletions = Object.fromEntries(
      this.pendingDeletions,
    );
    await this.saveSettings();
  }

  async executeHighlight(colorHex: string) {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile || activeFile.extension !== "pdf") return;

    // ── Guard: refuse to queue highlights for a known-encrypted file ─────────
    // Give instant feedback instead of letting the user highlight happily
    // only to see all their work discarded at flush time.
    if (this._encryptedFiles.has(activeFile.path)) {
      new Notice(
        `🔒 "${activeFile.name}" is password-protected and cannot be annotated.`,
      );
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

    this.drawTemporaryCssOverlay(
      selectionData.pageNumber,
      selectionData.rects,
      colorHex,
      opacityFloat,
    );

    const payload: PdfHighlightPayload = {
      pageNumber: selectionData.pageNumber,
      rects: selectionData.rects,
      colorRgb: colorArray,
      opacity: opacityFloat,
      author: this.settings.author,
      id: highlightId,
    };

    const existing = this.pendingHighlights.get(activeFile.path) ?? [];
    existing.push(payload);
    this.pendingHighlights.set(activeFile.path, existing);
    await this.syncPendingQueueToDisk();
    window.getSelection()?.empty();
  }

  async executeRemoveHighlight() {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile || activeFile.extension !== "pdf") return;

    if (this._encryptedFiles.has(activeFile.path)) {
      new Notice(
        `🔒 "${activeFile.name}" is password-protected and cannot be modified.`,
      );
      return;
    }

    const selectionData = this.selectionExtractor.getActiveSelection();
    if (!selectionData || selectionData.rects.length === 0) return;
    const cursorRect = selectionData.rects[0];
    if (!cursorRect) return;

    window.getSelection()?.empty();

    // Step 1: pending queue
    const qList = this.pendingHighlights.get(activeFile.path);
    if (qList && qList.length > 0) {
      const before = qList.length;
      const filtered = qList.filter(
        (p) =>
          !this.checkIntersection(
            p.pageNumber,
            p.rects,
            selectionData.pageNumber,
            cursorRect,
          ),
      );
      if (filtered.length < before) {
        this.pendingHighlights.set(activeFile.path, filtered);
        this.removeTemporaryCssOverlay(cursorRect, selectionData.pageNumber);
        await this.syncPendingQueueToDisk();
        new Notice("🗑️ Queued highlight cancelled.");
        return;
      }
    }

    // Step 2: read directly from PDF binary
    let savedAnnotations;
    try {
      savedAnnotations =
        await this.pdfAnnotator.readAnnotationsFromPdf(activeFile);
    } catch (e) {
      if (e instanceof EncryptedPdfError) {
        this._encryptedFiles.add(activeFile.path);
        new Notice(
          `🔒 "${activeFile.name}" is password-protected and cannot be modified.`,
        );
        return;
      }
      new Notice(
        `⚠️ Could not read "${activeFile.name}". Check the console for details.`,
      );
      return;
    }

    if (savedAnnotations.length === 0) {
      new Notice("⚠️ No saved highlights found in this PDF.");
      return;
    }

    const margin = 0.005;
    const target = savedAnnotations.find((ann) => {
      if (ann.pageNumber !== selectionData.pageNumber) return false;
      return (
        cursorRect.pLeft <= ann.pLeft + ann.pWidth + margin &&
        cursorRect.pLeft + cursorRect.pWidth >= ann.pLeft - margin &&
        cursorRect.pTop <= ann.pTop + ann.pHeight + margin &&
        cursorRect.pTop + cursorRect.pHeight >= ann.pTop - margin
      );
    });

    if (!target) {
      new Notice("⚠️ No highlight found at the selected position.");
      return;
    }

    const delQ = this.pendingDeletions.get(activeFile.path) ?? [];
    if (target.id) delQ.push(target.id);
    delQ.push(
      `SPATIAL:${target.pageNumber}:${target.pLeft},${target.pTop},${target.pWidth},${target.pHeight}`,
    );
    this.pendingDeletions.set(activeFile.path, delQ);
    await this.syncPendingQueueToDisk();
    await this.flushCache();
  }

  // ─── CSS overlay helpers ──────────────────────────────────────────────────
  drawTemporaryCssOverlay(
    pageNumber: number,
    rects: any[],
    colorHex: string,
    opacityFloat: number,
  ) {
    const container = this.app.workspace.activeLeaf?.view.containerEl;
    if (!container) return;

    const pageDiv = container.querySelector(
      `.page[data-page-number="${pageNumber}"]`,
    );
    if (!pageDiv) return;

    let tempLayer = pageDiv.querySelector(".temp-highlights-layer");
    if (!tempLayer) {
      tempLayer = document.createElement("div");
      tempLayer.className = "temp-highlights-layer";
      (tempLayer as HTMLElement).style.cssText =
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

  removeTemporaryCssOverlay(cursorRect: any, pageNumber: number) {
    const container = this.app.workspace.activeLeaf?.view.containerEl;
    if (!container) return;

    const pageDiv = container.querySelector(
      `.page[data-page-number="${pageNumber}"]`,
    );
    const tempLayer = pageDiv?.querySelector(".temp-highlights-layer");
    if (!tempLayer) return;

    for (const el of Array.from(tempLayer.children) as HTMLElement[]) {
      const l = parseFloat(el.style.left) / 100;
      const w = parseFloat(el.style.width) / 100;
      const t = parseFloat(el.style.top) / 100;
      const h = parseFloat(el.style.height) / 100;

      if (
        cursorRect.pLeft <= l + w &&
        cursorRect.pLeft + cursorRect.pWidth >= l &&
        cursorRect.pTop <= t + h &&
        cursorRect.pTop + cursorRect.pHeight >= t
      )
        el.remove();
    }
  }

  reinjectCssOverlays() {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile || activeFile.extension !== "pdf") return;

    const pending = this.pendingHighlights.get(activeFile.path);
    if (!pending || pending.length === 0) return;

    const container = this.app.workspace.activeLeaf?.view.containerEl;
    if (!container) return;

    const byPage = new Map<number, PdfHighlightPayload[]>();
    for (const p of pending) {
      const arr = byPage.get(p.pageNumber) ?? [];
      arr.push(p);
      byPage.set(p.pageNumber, arr);
    }

    for (const [pageNumber, highlights] of byPage.entries()) {
      const pageDiv = container.querySelector(
        `.page[data-page-number="${pageNumber}"]`,
      );
      if (!pageDiv || pageDiv.querySelector(".temp-highlights-layer")) continue;
      for (const hl of highlights) {
        const cssColor = `rgb(${Math.round(hl.colorRgb[0] * 255)}, ${Math.round(hl.colorRgb[1] * 255)}, ${Math.round(hl.colorRgb[2] * 255)})`;
        this.drawTemporaryCssOverlay(
          hl.pageNumber,
          hl.rects,
          cssColor,
          hl.opacity,
        );
      }
    }
  }

  checkIntersection(
    hlPage: number,
    hlRects: any[],
    cursorPage: number,
    cursorRect: any,
  ): boolean {
    if (hlPage !== cursorPage) return false;
    const margin = 0.005;
    for (const r of hlRects) {
      if (
        cursorRect.pLeft <= r.pLeft + r.pWidth + margin &&
        cursorRect.pLeft + cursorRect.pWidth >= r.pLeft - margin &&
        cursorRect.pTop <= r.pTop + r.pHeight + margin &&
        cursorRect.pTop + cursorRect.pHeight >= r.pTop - margin
      )
        return true;
    }
    return false;
  }

  onunload() {
    this.syncPendingQueueToDisk().catch(console.error);
    this.flushCache().catch(console.error);
    console.log("AnnotatePDF by bishwaa unloaded");
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class PdfHighlighterSettingTab extends PluginSettingTab {
  plugin: PdfHighlighterBishwaaPlugin;

  constructor(app: App, plugin: PdfHighlighterBishwaaPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "AnnotatePDF Native Settings" });

    new Setting(containerEl)
      .setName("Author Name")
      .setDesc("Stored natively in the PDF annotation metadata.")
      .addText((text) =>
        text.setValue(this.plugin.settings.author).onChange(async (value) => {
          this.plugin.settings.author = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Primary Color (Hotkey: h)")
      .addColorPicker((color) =>
        color
          .setValue(this.plugin.settings.hexColorPrimary)
          .onChange(async (value) => {
            this.plugin.settings.hexColorPrimary = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Secondary Color (Hotkey: g)")
      .addColorPicker((color) =>
        color
          .setValue(this.plugin.settings.hexColorSecondary)
          .onChange(async (value) => {
            this.plugin.settings.hexColorSecondary = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Tertiary Color (Hotkey: j)")
      .addColorPicker((color) =>
        color
          .setValue(this.plugin.settings.hexColorTertiary)
          .onChange(async (value) => {
            this.plugin.settings.hexColorTertiary = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Highlight Opacity")
      .setDesc("Native PDF alpha opacity (0–100).")
      .addSlider((slider) =>
        slider
          .setLimits(0, 100, 1)
          .setValue(this.plugin.settings.opacity)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.opacity = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Reset Cache")
      .setDesc(
        "Clears all pending queues, the JSON audit log, and the encrypted-file blocklist. " +
          "Use this if you removed a password from a PDF and want to annotate it again.",
      )
      .addButton((btn) =>
        btn
          .setButtonText("Reset")
          .setWarning()
          .onClick(async () => {
            this.plugin.pendingHighlights.clear();
            this.plugin.pendingDeletions.clear();
            this.plugin.settings.unflushedHighlights = {};
            this.plugin.settings.unflushedDeletions = {};
            this.plugin._encryptedFiles.clear(); // allow retrying previously blocked files
            await this.plugin.saveData({ fileMap: {} });
            await this.plugin.saveSettings();
            new Notice("✅ Cache reset.");
          }),
      );
  }
}

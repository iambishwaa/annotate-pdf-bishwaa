import { App, TFile } from "obsidian";
import {
  PDFDocument,
  PDFString,
  PDFName,
  PDFDict,
  PDFArray,
  PDFRef,
  PDFNumber,
} from "pdf-lib";
import { RectOverlay } from "../highlight/SelectionExtractor";

export interface PdfHighlightPayload {
  pageNumber: number;
  rects: RectOverlay[];
  colorRgb: [number, number, number];
  opacity: number;
  author: string;
  id: string;
}

export interface SavedAnnotationInfo {
  id: string | null;
  pageNumber: number;
  pLeft: number;
  pTop: number;
  pWidth: number;
  pHeight: number;
}

export class EncryptedPdfError extends Error {
  constructor(fileName: string) {
    super(`"${fileName}" is password-protected and cannot be annotated.`);
    this.name = "EncryptedPdfError";
  }
}

export class LockedPdfError extends Error {
  constructor(fileName: string) {
    super(`"${fileName}" is locked by another application.`);
    this.name = "LockedPdfError";
  }
}

export class PdfAnnotator {
  app: App;

  constructor(app: App) {
    this.app = app;
  }

  // ── Read all existing Highlight annotations from the PDF binary ───────────
  async readAnnotationsFromPdf(file: TFile): Promise<SavedAnnotationInfo[]> {
    const results: SavedAnnotationInfo[] = [];
    try {
      const bytes = await this.app.vault.readBinary(file);

      // Check for encryption BEFORE loading with ignoreEncryption
      // so we can surface a meaningful error to the caller.
      await this._assertNotEncrypted(bytes, file.name);

      const pdfDoc = await PDFDocument.load(bytes, {
        updateMetadata: false,
        ignoreEncryption: false,
      });

      const pages = pdfDoc.getPages();
      for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
        const page = pages[pageIdx];
        if (!page) continue;

        const { width, height } = page.getSize();
        const annotsObj = this._resolveAnnotsArray(pdfDoc, page);
        if (!annotsObj) continue;

        for (let i = 0; i < annotsObj.size(); i++) {
          const annotRef = annotsObj.get(i);
          const annot = pdfDoc.context.lookupMaybe(annotRef, PDFDict);
          if (!annot) continue;

          const subtype = annot.get(PDFName.of("Subtype"));
          if (!subtype || subtype.toString() !== "/Highlight") continue;

          let id: string | null = null;
          const nmObj = annot.get(PDFName.of("NM"));
          if (nmObj instanceof PDFString) {
            try {
              id = nmObj.decodeText();
            } catch {
              id = nmObj.asString();
            }
          }

          const rectArray = annot.get(PDFName.of("Rect"));
          if (!(rectArray instanceof PDFArray) || rectArray.size() !== 4)
            continue;

          const minX = (rectArray.get(0) as PDFNumber).asNumber();
          const minY = (rectArray.get(1) as PDFNumber).asNumber();
          const maxX = (rectArray.get(2) as PDFNumber).asNumber();
          const maxY = (rectArray.get(3) as PDFNumber).asNumber();

          results.push({
            id,
            pageNumber: pageIdx + 1,
            pLeft: minX / width,
            pTop: 1 - maxY / height,
            pWidth: (maxX - minX) / width,
            pHeight: (maxY - minY) / height,
          });
        }
      }
    } catch (e) {
      // Re-throw our typed errors; swallow everything else
      if (e instanceof EncryptedPdfError) throw e;
      console.error("[AnnotatePDF] readAnnotationsFromPdf failed:", e);
    }
    return results;
  }

  // ── Write additions + deletions to the PDF in one atomic pass ─────────────
  async applyBatchUpdatesToPdf(
    file: TFile,
    payloads: PdfHighlightPayload[],
    deletionIds: string[],
  ): Promise<void> {
    if (payloads.length === 0 && deletionIds.length === 0) return;

    const fileContent = await this.app.vault.readBinary(file);

    // ── Encryption check ────────────────────────────────────────────────
    // Must happen before we try to load + save, otherwise pdf-lib throws
    // a generic EncryptedPDFError that looks identical to a parse failure.
    await this._assertNotEncrypted(fileContent, file.name);

    let pdfDoc: PDFDocument;
    try {
      pdfDoc = await PDFDocument.load(fileContent, {
        updateMetadata: false,
        ignoreEncryption: false,
      });
    } catch (e: any) {
      // pdf-lib's own EncryptedPDFError (belt-and-suspenders catch)
      if (
        e?.name === "EncryptedPDFError" ||
        e?.message?.includes("encrypted")
      ) {
        throw new EncryptedPdfError(file.name);
      }
      // Anything else is likely a file-lock / corruption — treat as retryable
      throw new LockedPdfError(file.name);
    }

    const pages = pdfDoc.getPages();

    // ── Deletions ────────────────────────────────────────────────────────
    if (deletionIds.length > 0) {
      const exactIds = new Set(
        deletionIds.filter((id) => !id.startsWith("SPATIAL:")),
      );
      const spatialTargets = deletionIds
        .filter((id) => id.startsWith("SPATIAL:"))
        .map((id) => this._parseSpatialId(id));

      for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
        const page = pages[pageIdx];
        if (!page) continue;

        const { width, height } = page.getSize();
        const annotsObj = this._resolveAnnotsArray(pdfDoc, page);
        if (!annotsObj) continue;

        const toDelete: number[] = [];

        for (let i = 0; i < annotsObj.size(); i++) {
          const annotRef = annotsObj.get(i);
          const annot = pdfDoc.context.lookupMaybe(annotRef, PDFDict);
          if (!annot) continue;

          // Exact NM match
          if (exactIds.size > 0) {
            const nmObj = annot.get(PDFName.of("NM"));
            if (nmObj instanceof PDFString) {
              let nmValue: string | null = null;
              try {
                nmValue = nmObj.decodeText();
              } catch {
                nmValue = nmObj.asString();
              }
              if (nmValue !== null && exactIds.has(nmValue)) {
                toDelete.push(i);
                continue;
              }
            }
          }

          // Spatial overlap fallback
          if (spatialTargets.length > 0) {
            const subtype = annot.get(PDFName.of("Subtype"));
            if (!subtype || subtype.toString() !== "/Highlight") continue;

            const rectArray = annot.get(PDFName.of("Rect"));
            if (!(rectArray instanceof PDFArray) || rectArray.size() !== 4)
              continue;

            const aMinX = (rectArray.get(0) as PDFNumber).asNumber();
            const aMinY = (rectArray.get(1) as PDFNumber).asNumber();
            const aMaxX = (rectArray.get(2) as PDFNumber).asNumber();
            const aMaxY = (rectArray.get(3) as PDFNumber).asNumber();

            const pageNum = pageIdx + 1;
            for (const s of spatialTargets) {
              if (s.page !== pageNum) continue;
              const TOLERANCE = 2;
              const sMinX = s.rect.pLeft * width;
              const sMaxX = (s.rect.pLeft + s.rect.pWidth) * width;
              const sMinY = height - (s.rect.pTop + s.rect.pHeight) * height;
              const sMaxY = height - s.rect.pTop * height;

              if (
                Math.max(aMinX, sMinX - TOLERANCE) <
                  Math.min(aMaxX, sMaxX + TOLERANCE) &&
                Math.max(aMinY, sMinY - TOLERANCE) <
                  Math.min(aMaxY, sMaxY + TOLERANCE)
              ) {
                toDelete.push(i);
                break;
              }
            }
          }
        }

        for (let k = toDelete.length - 1; k >= 0; k--) {
          const idx = toDelete[k]!;
          const annotRef = annotsObj.get(idx);
          annotsObj.remove(idx);
          if (annotRef instanceof PDFRef) {
            try {
              pdfDoc.context.delete(annotRef);
            } catch {
              /* already gone */
            }
          }
        }
      }
    }

    // ── Additions ────────────────────────────────────────────────────────
    for (const payload of payloads) {
      const page = pages[payload.pageNumber - 1];
      if (!page) continue;

      const { width, height } = page.getSize();
      const quadPointsList: number[] = [];
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;

      for (const r of payload.rects) {
        const rMinX = r.pLeft * width;
        const rMaxX = (r.pLeft + r.pWidth) * width;
        const rMinY = height - (r.pTop + r.pHeight) * height;
        const rMaxY = height - r.pTop * height;

        quadPointsList.push(
          rMinX,
          rMaxY,
          rMaxX,
          rMaxY,
          rMinX,
          rMinY,
          rMaxX,
          rMinY,
        );
        minX = Math.min(minX, rMinX);
        maxX = Math.max(maxX, rMaxX);
        minY = Math.min(minY, rMinY);
        maxY = Math.max(maxY, rMaxY);
      }

      const highlightAnnotation = pdfDoc.context.obj({
        Type: "Annot",
        Subtype: "Highlight",
        NM: PDFString.of(payload.id),
        Rect: [minX, minY, maxX, maxY],
        QuadPoints: quadPointsList,
        C: payload.colorRgb,
        CA: payload.opacity,
        T: PDFString.of(payload.author),
        CreationDate: PDFString.of(this._pdfDateString()),
        M: PDFString.of(this._pdfDateString()),
        F: 4,
      });

      const annotationRef = pdfDoc.context.register(highlightAnnotation);
      let annotsObj = this._resolveAnnotsArray(pdfDoc, page);
      if (!annotsObj) {
        // After
        const newArr = pdfDoc.context.obj([]) as PDFArray;
        page.node.set(PDFName.of("Annots"), newArr);
        annotsObj = newArr;
      }
      annotsObj.push(annotationRef);
    }

    // ── Save ─────────────────────────────────────────────────────────────
    try {
      const modifiedPdfBytes = await pdfDoc.save();
      await this.app.vault.modifyBinary(
        file,
        modifiedPdfBytes.buffer as ArrayBuffer,
      );
    } catch {
      // Save failures are almost always OS file locks
      throw new LockedPdfError(file.name);
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async _assertNotEncrypted(
    bytes: ArrayBuffer,
    fileName: string,
  ): Promise<void> {
    try {
      await PDFDocument.load(bytes, {
        updateMetadata: false,
        ignoreEncryption: false,
      });
    } catch (e: any) {
      if (
        e?.name === "EncryptedPDFError" ||
        e?.message?.toLowerCase().includes("encrypt")
      ) {
        throw new EncryptedPdfError(fileName);
      }
    }
  }

  private _resolveAnnotsArray(
    pdfDoc: PDFDocument,
    page: ReturnType<PDFDocument["getPages"]>[number],
  ): PDFArray | null {
    const annotsVal = page.node.Annots();
    if (!annotsVal) return null;
    const resolved = pdfDoc.context.lookup(annotsVal);
    if (resolved instanceof PDFArray) return resolved;
    return null;
  }

  private _parseSpatialId(id: string) {
    const parts = id.split(":");
    const pageNum = parseInt(parts[1] ?? "1", 10);
    const rectParts = (parts[2] ?? "0,0,0,0").split(",").map(Number);
    return {
      page: isNaN(pageNum) ? 1 : pageNum,
      rect: {
        pLeft: rectParts[0] ?? 0,
        pTop: rectParts[1] ?? 0,
        pWidth: rectParts[2] ?? 0,
        pHeight: rectParts[3] ?? 0,
      },
    };
  }

  private _pdfDateString(): string {
    const now = new Date();
    const pad = (n: number, l = 2) => n.toString().padStart(l, "0");
    const offsetMin = -now.getTimezoneOffset();
    const sign = offsetMin >= 0 ? "+" : "-";
    const absOff = Math.abs(offsetMin);
    return (
      `D:${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
      `${sign}${pad(Math.floor(absOff / 60))}'${pad(absOff % 60)}'`
    );
  }
}
// bishwaa

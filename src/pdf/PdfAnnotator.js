import { __awaiter } from "tslib";
import { PDFDocument, PDFString, PDFName, PDFDict, PDFArray, PDFRef, } from "pdf-lib";
export class EncryptedPdfError extends Error {
    constructor(fileName) {
        super(`"${fileName}" is password-protected and cannot be annotated.`);
        this.name = "EncryptedPdfError";
    }
}
export class LockedPdfError extends Error {
    constructor(fileName) {
        super(`"${fileName}" is locked by another application.`);
        this.name = "LockedPdfError";
    }
}
export class PdfAnnotator {
    constructor(app) {
        this.app = app;
    }
    // ── Read all existing Highlight annotations from the PDF binary ───────────
    readAnnotationsFromPdf(file) {
        return __awaiter(this, void 0, void 0, function* () {
            const results = [];
            try {
                const bytes = yield this.app.vault.readBinary(file);
                // Check for encryption BEFORE loading with ignoreEncryption
                // so we can surface a meaningful error to the caller.
                yield this._assertNotEncrypted(bytes, file.name);
                const pdfDoc = yield PDFDocument.load(bytes, {
                    updateMetadata: false,
                    ignoreEncryption: false,
                });
                const pages = pdfDoc.getPages();
                for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
                    const page = pages[pageIdx];
                    if (!page)
                        continue;
                    const { width, height } = page.getSize();
                    const annotsObj = this._resolveAnnotsArray(pdfDoc, page);
                    if (!annotsObj)
                        continue;
                    for (let i = 0; i < annotsObj.size(); i++) {
                        const annotRef = annotsObj.get(i);
                        const annot = pdfDoc.context.lookupMaybe(annotRef, PDFDict);
                        if (!annot)
                            continue;
                        const subtype = annot.get(PDFName.of("Subtype"));
                        if (!subtype || subtype.toString() !== "/Highlight")
                            continue;
                        let id = null;
                        const nmObj = annot.get(PDFName.of("NM"));
                        if (nmObj instanceof PDFString) {
                            try {
                                id = nmObj.decodeText();
                            }
                            catch (_a) {
                                id = nmObj.asString();
                            }
                        }
                        const rectArray = annot.get(PDFName.of("Rect"));
                        if (!(rectArray instanceof PDFArray) || rectArray.size() !== 4)
                            continue;
                        const minX = rectArray.get(0).asNumber();
                        const minY = rectArray.get(1).asNumber();
                        const maxX = rectArray.get(2).asNumber();
                        const maxY = rectArray.get(3).asNumber();
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
            }
            catch (e) {
                // Re-throw our typed errors; swallow everything else
                if (e instanceof EncryptedPdfError)
                    throw e;
                console.error("[AnnotatePDF] readAnnotationsFromPdf failed:", e);
            }
            return results;
        });
    }
    // ── Write additions + deletions to the PDF in one atomic pass ─────────────
    applyBatchUpdatesToPdf(file, payloads, deletionIds) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            if (payloads.length === 0 && deletionIds.length === 0)
                return;
            const fileContent = yield this.app.vault.readBinary(file);
            // ── Encryption check ────────────────────────────────────────────────
            // Must happen before we try to load + save, otherwise pdf-lib throws
            // a generic EncryptedPDFError that looks identical to a parse failure.
            yield this._assertNotEncrypted(fileContent, file.name);
            let pdfDoc;
            try {
                pdfDoc = yield PDFDocument.load(fileContent, {
                    updateMetadata: false,
                    ignoreEncryption: false,
                });
            }
            catch (e) {
                // pdf-lib's own EncryptedPDFError (belt-and-suspenders catch)
                if ((e === null || e === void 0 ? void 0 : e.name) === "EncryptedPDFError" ||
                    ((_a = e === null || e === void 0 ? void 0 : e.message) === null || _a === void 0 ? void 0 : _a.includes("encrypted"))) {
                    throw new EncryptedPdfError(file.name);
                }
                // Anything else is likely a file-lock / corruption — treat as retryable
                throw new LockedPdfError(file.name);
            }
            const pages = pdfDoc.getPages();
            // ── Deletions ────────────────────────────────────────────────────────
            if (deletionIds.length > 0) {
                const exactIds = new Set(deletionIds.filter((id) => !id.startsWith("SPATIAL:")));
                const spatialTargets = deletionIds
                    .filter((id) => id.startsWith("SPATIAL:"))
                    .map((id) => this._parseSpatialId(id));
                for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
                    const page = pages[pageIdx];
                    if (!page)
                        continue;
                    const { width, height } = page.getSize();
                    const annotsObj = this._resolveAnnotsArray(pdfDoc, page);
                    if (!annotsObj)
                        continue;
                    const toDelete = [];
                    for (let i = 0; i < annotsObj.size(); i++) {
                        const annotRef = annotsObj.get(i);
                        const annot = pdfDoc.context.lookupMaybe(annotRef, PDFDict);
                        if (!annot)
                            continue;
                        // Exact NM match
                        if (exactIds.size > 0) {
                            const nmObj = annot.get(PDFName.of("NM"));
                            if (nmObj instanceof PDFString) {
                                let nmValue = null;
                                try {
                                    nmValue = nmObj.decodeText();
                                }
                                catch (_b) {
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
                            if (!subtype || subtype.toString() !== "/Highlight")
                                continue;
                            const rectArray = annot.get(PDFName.of("Rect"));
                            if (!(rectArray instanceof PDFArray) || rectArray.size() !== 4)
                                continue;
                            const aMinX = rectArray.get(0).asNumber();
                            const aMinY = rectArray.get(1).asNumber();
                            const aMaxX = rectArray.get(2).asNumber();
                            const aMaxY = rectArray.get(3).asNumber();
                            const pageNum = pageIdx + 1;
                            for (const s of spatialTargets) {
                                if (s.page !== pageNum)
                                    continue;
                                const TOLERANCE = 2;
                                const sMinX = s.rect.pLeft * width;
                                const sMaxX = (s.rect.pLeft + s.rect.pWidth) * width;
                                const sMinY = height - (s.rect.pTop + s.rect.pHeight) * height;
                                const sMaxY = height - s.rect.pTop * height;
                                if (Math.max(aMinX, sMinX - TOLERANCE) <
                                    Math.min(aMaxX, sMaxX + TOLERANCE) &&
                                    Math.max(aMinY, sMinY - TOLERANCE) <
                                        Math.min(aMaxY, sMaxY + TOLERANCE)) {
                                    toDelete.push(i);
                                    break;
                                }
                            }
                        }
                    }
                    for (let k = toDelete.length - 1; k >= 0; k--) {
                        const idx = toDelete[k];
                        const annotRef = annotsObj.get(idx);
                        annotsObj.remove(idx);
                        if (annotRef instanceof PDFRef) {
                            try {
                                pdfDoc.context.delete(annotRef);
                            }
                            catch (_c) {
                                /* already gone */
                            }
                        }
                    }
                }
            }
            // ── Additions ────────────────────────────────────────────────────────
            for (const payload of payloads) {
                const page = pages[payload.pageNumber - 1];
                if (!page)
                    continue;
                const { width, height } = page.getSize();
                const quadPointsList = [];
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                for (const r of payload.rects) {
                    const rMinX = r.pLeft * width;
                    const rMaxX = (r.pLeft + r.pWidth) * width;
                    const rMinY = height - (r.pTop + r.pHeight) * height;
                    const rMaxY = height - r.pTop * height;
                    quadPointsList.push(rMinX, rMaxY, rMaxX, rMaxY, rMinX, rMinY, rMaxX, rMinY);
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
                    const newArr = pdfDoc.context.obj([]);
                    page.node.set(PDFName.of("Annots"), newArr);
                    annotsObj = newArr;
                }
                annotsObj.push(annotationRef);
            }
            // ── Save ─────────────────────────────────────────────────────────────
            try {
                const modifiedPdfBytes = yield pdfDoc.save();
                yield this.app.vault.modifyBinary(file, modifiedPdfBytes.buffer);
            }
            catch (_d) {
                // Save failures are almost always OS file locks
                throw new LockedPdfError(file.name);
            }
        });
    }
    // ── Private helpers ───────────────────────────────────────────────────────
    _assertNotEncrypted(bytes, fileName) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            try {
                yield PDFDocument.load(bytes, {
                    updateMetadata: false,
                    ignoreEncryption: false,
                });
            }
            catch (e) {
                if ((e === null || e === void 0 ? void 0 : e.name) === "EncryptedPDFError" ||
                    ((_a = e === null || e === void 0 ? void 0 : e.message) === null || _a === void 0 ? void 0 : _a.toLowerCase().includes("encrypt"))) {
                    throw new EncryptedPdfError(fileName);
                }
            }
        });
    }
    _resolveAnnotsArray(pdfDoc, page) {
        const annotsVal = page.node.Annots();
        if (!annotsVal)
            return null;
        const resolved = pdfDoc.context.lookup(annotsVal);
        if (resolved instanceof PDFArray)
            return resolved;
        return null;
    }
    _parseSpatialId(id) {
        var _a, _b, _c, _d, _e, _f;
        const parts = id.split(":");
        const pageNum = parseInt((_a = parts[1]) !== null && _a !== void 0 ? _a : "1", 10);
        const rectParts = ((_b = parts[2]) !== null && _b !== void 0 ? _b : "0,0,0,0").split(",").map(Number);
        return {
            page: isNaN(pageNum) ? 1 : pageNum,
            rect: {
                pLeft: (_c = rectParts[0]) !== null && _c !== void 0 ? _c : 0,
                pTop: (_d = rectParts[1]) !== null && _d !== void 0 ? _d : 0,
                pWidth: (_e = rectParts[2]) !== null && _e !== void 0 ? _e : 0,
                pHeight: (_f = rectParts[3]) !== null && _f !== void 0 ? _f : 0,
            },
        };
    }
    _pdfDateString() {
        const now = new Date();
        const pad = (n, l = 2) => n.toString().padStart(l, "0");
        const offsetMin = -now.getTimezoneOffset();
        const sign = offsetMin >= 0 ? "+" : "-";
        const absOff = Math.abs(offsetMin);
        return (`D:${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
            `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
            `${sign}${pad(Math.floor(absOff / 60))}'${pad(absOff % 60)}'`);
    }
}
// bishwaa
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiUGRmQW5ub3RhdG9yLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiUGRmQW5ub3RhdG9yLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFDQSxPQUFPLEVBQ0wsV0FBVyxFQUNYLFNBQVMsRUFDVCxPQUFPLEVBQ1AsT0FBTyxFQUNQLFFBQVEsRUFDUixNQUFNLEdBRVAsTUFBTSxTQUFTLENBQUM7QUFxQmpCLE1BQU0sT0FBTyxpQkFBa0IsU0FBUSxLQUFLO0lBQzFDLFlBQVksUUFBZ0I7UUFDMUIsS0FBSyxDQUFDLElBQUksUUFBUSxrREFBa0QsQ0FBQyxDQUFDO1FBQ3RFLElBQUksQ0FBQyxJQUFJLEdBQUcsbUJBQW1CLENBQUM7SUFDbEMsQ0FBQztDQUNGO0FBRUQsTUFBTSxPQUFPLGNBQWUsU0FBUSxLQUFLO0lBQ3ZDLFlBQVksUUFBZ0I7UUFDMUIsS0FBSyxDQUFDLElBQUksUUFBUSxxQ0FBcUMsQ0FBQyxDQUFDO1FBQ3pELElBQUksQ0FBQyxJQUFJLEdBQUcsZ0JBQWdCLENBQUM7SUFDL0IsQ0FBQztDQUNGO0FBRUQsTUFBTSxPQUFPLFlBQVk7SUFHdkIsWUFBWSxHQUFRO1FBQ2xCLElBQUksQ0FBQyxHQUFHLEdBQUcsR0FBRyxDQUFDO0lBQ2pCLENBQUM7SUFFRCw2RUFBNkU7SUFDdkUsc0JBQXNCLENBQUMsSUFBVzs7WUFDdEMsTUFBTSxPQUFPLEdBQTBCLEVBQUUsQ0FBQztZQUMxQyxJQUFJLENBQUM7Z0JBQ0gsTUFBTSxLQUFLLEdBQUcsTUFBTSxJQUFJLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxVQUFVLENBQUMsSUFBSSxDQUFDLENBQUM7Z0JBRXBELDREQUE0RDtnQkFDNUQsc0RBQXNEO2dCQUN0RCxNQUFNLElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxLQUFLLEVBQUUsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO2dCQUVqRCxNQUFNLE1BQU0sR0FBRyxNQUFNLFdBQVcsQ0FBQyxJQUFJLENBQUMsS0FBSyxFQUFFO29CQUMzQyxjQUFjLEVBQUUsS0FBSztvQkFDckIsZ0JBQWdCLEVBQUUsS0FBSztpQkFDeEIsQ0FBQyxDQUFDO2dCQUVILE1BQU0sS0FBSyxHQUFHLE1BQU0sQ0FBQyxRQUFRLEVBQUUsQ0FBQztnQkFDaEMsS0FBSyxJQUFJLE9BQU8sR0FBRyxDQUFDLEVBQUUsT0FBTyxHQUFHLEtBQUssQ0FBQyxNQUFNLEVBQUUsT0FBTyxFQUFFLEVBQUUsQ0FBQztvQkFDeEQsTUFBTSxJQUFJLEdBQUcsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDO29CQUM1QixJQUFJLENBQUMsSUFBSTt3QkFBRSxTQUFTO29CQUVwQixNQUFNLEVBQUUsS0FBSyxFQUFFLE1BQU0sRUFBRSxHQUFHLElBQUksQ0FBQyxPQUFPLEVBQUUsQ0FBQztvQkFDekMsTUFBTSxTQUFTLEdBQUcsSUFBSSxDQUFDLG1CQUFtQixDQUFDLE1BQU0sRUFBRSxJQUFJLENBQUMsQ0FBQztvQkFDekQsSUFBSSxDQUFDLFNBQVM7d0JBQUUsU0FBUztvQkFFekIsS0FBSyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxHQUFHLFNBQVMsQ0FBQyxJQUFJLEVBQUUsRUFBRSxDQUFDLEVBQUUsRUFBRSxDQUFDO3dCQUMxQyxNQUFNLFFBQVEsR0FBRyxTQUFTLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDO3dCQUNsQyxNQUFNLEtBQUssR0FBRyxNQUFNLENBQUMsT0FBTyxDQUFDLFdBQVcsQ0FBQyxRQUFRLEVBQUUsT0FBTyxDQUFDLENBQUM7d0JBQzVELElBQUksQ0FBQyxLQUFLOzRCQUFFLFNBQVM7d0JBRXJCLE1BQU0sT0FBTyxHQUFHLEtBQUssQ0FBQyxHQUFHLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDO3dCQUNqRCxJQUFJLENBQUMsT0FBTyxJQUFJLE9BQU8sQ0FBQyxRQUFRLEVBQUUsS0FBSyxZQUFZOzRCQUFFLFNBQVM7d0JBRTlELElBQUksRUFBRSxHQUFrQixJQUFJLENBQUM7d0JBQzdCLE1BQU0sS0FBSyxHQUFHLEtBQUssQ0FBQyxHQUFHLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDO3dCQUMxQyxJQUFJLEtBQUssWUFBWSxTQUFTLEVBQUUsQ0FBQzs0QkFDL0IsSUFBSSxDQUFDO2dDQUNILEVBQUUsR0FBRyxLQUFLLENBQUMsVUFBVSxFQUFFLENBQUM7NEJBQzFCLENBQUM7NEJBQUMsV0FBTSxDQUFDO2dDQUNQLEVBQUUsR0FBRyxLQUFLLENBQUMsUUFBUSxFQUFFLENBQUM7NEJBQ3hCLENBQUM7d0JBQ0gsQ0FBQzt3QkFFRCxNQUFNLFNBQVMsR0FBRyxLQUFLLENBQUMsR0FBRyxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQzt3QkFDaEQsSUFBSSxDQUFDLENBQUMsU0FBUyxZQUFZLFFBQVEsQ0FBQyxJQUFJLFNBQVMsQ0FBQyxJQUFJLEVBQUUsS0FBSyxDQUFDOzRCQUM1RCxTQUFTO3dCQUVYLE1BQU0sSUFBSSxHQUFJLFNBQVMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFlLENBQUMsUUFBUSxFQUFFLENBQUM7d0JBQ3hELE1BQU0sSUFBSSxHQUFJLFNBQVMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFlLENBQUMsUUFBUSxFQUFFLENBQUM7d0JBQ3hELE1BQU0sSUFBSSxHQUFJLFNBQVMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFlLENBQUMsUUFBUSxFQUFFLENBQUM7d0JBQ3hELE1BQU0sSUFBSSxHQUFJLFNBQVMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFlLENBQUMsUUFBUSxFQUFFLENBQUM7d0JBRXhELE9BQU8sQ0FBQyxJQUFJLENBQUM7NEJBQ1gsRUFBRTs0QkFDRixVQUFVLEVBQUUsT0FBTyxHQUFHLENBQUM7NEJBQ3ZCLEtBQUssRUFBRSxJQUFJLEdBQUcsS0FBSzs0QkFDbkIsSUFBSSxFQUFFLENBQUMsR0FBRyxJQUFJLEdBQUcsTUFBTTs0QkFDdkIsTUFBTSxFQUFFLENBQUMsSUFBSSxHQUFHLElBQUksQ0FBQyxHQUFHLEtBQUs7NEJBQzdCLE9BQU8sRUFBRSxDQUFDLElBQUksR0FBRyxJQUFJLENBQUMsR0FBRyxNQUFNO3lCQUNoQyxDQUFDLENBQUM7b0JBQ0wsQ0FBQztnQkFDSCxDQUFDO1lBQ0gsQ0FBQztZQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7Z0JBQ1gscURBQXFEO2dCQUNyRCxJQUFJLENBQUMsWUFBWSxpQkFBaUI7b0JBQUUsTUFBTSxDQUFDLENBQUM7Z0JBQzVDLE9BQU8sQ0FBQyxLQUFLLENBQUMsOENBQThDLEVBQUUsQ0FBQyxDQUFDLENBQUM7WUFDbkUsQ0FBQztZQUNELE9BQU8sT0FBTyxDQUFDO1FBQ2pCLENBQUM7S0FBQTtJQUVELDZFQUE2RTtJQUN2RSxzQkFBc0IsQ0FDMUIsSUFBVyxFQUNYLFFBQStCLEVBQy9CLFdBQXFCOzs7WUFFckIsSUFBSSxRQUFRLENBQUMsTUFBTSxLQUFLLENBQUMsSUFBSSxXQUFXLENBQUMsTUFBTSxLQUFLLENBQUM7Z0JBQUUsT0FBTztZQUU5RCxNQUFNLFdBQVcsR0FBRyxNQUFNLElBQUksQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLFVBQVUsQ0FBQyxJQUFJLENBQUMsQ0FBQztZQUUxRCx1RUFBdUU7WUFDdkUscUVBQXFFO1lBQ3JFLHVFQUF1RTtZQUN2RSxNQUFNLElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxXQUFXLEVBQUUsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO1lBRXZELElBQUksTUFBbUIsQ0FBQztZQUN4QixJQUFJLENBQUM7Z0JBQ0gsTUFBTSxHQUFHLE1BQU0sV0FBVyxDQUFDLElBQUksQ0FBQyxXQUFXLEVBQUU7b0JBQzNDLGNBQWMsRUFBRSxLQUFLO29CQUNyQixnQkFBZ0IsRUFBRSxLQUFLO2lCQUN4QixDQUFDLENBQUM7WUFDTCxDQUFDO1lBQUMsT0FBTyxDQUFNLEVBQUUsQ0FBQztnQkFDaEIsOERBQThEO2dCQUM5RCxJQUNFLENBQUEsQ0FBQyxhQUFELENBQUMsdUJBQUQsQ0FBQyxDQUFFLElBQUksTUFBSyxtQkFBbUI7cUJBQy9CLE1BQUEsQ0FBQyxhQUFELENBQUMsdUJBQUQsQ0FBQyxDQUFFLE9BQU8sMENBQUUsUUFBUSxDQUFDLFdBQVcsQ0FBQyxDQUFBLEVBQ2pDLENBQUM7b0JBQ0QsTUFBTSxJQUFJLGlCQUFpQixDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztnQkFDekMsQ0FBQztnQkFDRCx3RUFBd0U7Z0JBQ3hFLE1BQU0sSUFBSSxjQUFjLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO1lBQ3RDLENBQUM7WUFFRCxNQUFNLEtBQUssR0FBRyxNQUFNLENBQUMsUUFBUSxFQUFFLENBQUM7WUFFaEMsd0VBQXdFO1lBQ3hFLElBQUksV0FBVyxDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUUsQ0FBQztnQkFDM0IsTUFBTSxRQUFRLEdBQUcsSUFBSSxHQUFHLENBQ3RCLFdBQVcsQ0FBQyxNQUFNLENBQUMsQ0FBQyxFQUFFLEVBQUUsRUFBRSxDQUFDLENBQUMsRUFBRSxDQUFDLFVBQVUsQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUN2RCxDQUFDO2dCQUNGLE1BQU0sY0FBYyxHQUFHLFdBQVc7cUJBQy9CLE1BQU0sQ0FBQyxDQUFDLEVBQUUsRUFBRSxFQUFFLENBQUMsRUFBRSxDQUFDLFVBQVUsQ0FBQyxVQUFVLENBQUMsQ0FBQztxQkFDekMsR0FBRyxDQUFDLENBQUMsRUFBRSxFQUFFLEVBQUUsQ0FBQyxJQUFJLENBQUMsZUFBZSxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUM7Z0JBRXpDLEtBQUssSUFBSSxPQUFPLEdBQUcsQ0FBQyxFQUFFLE9BQU8sR0FBRyxLQUFLLENBQUMsTUFBTSxFQUFFLE9BQU8sRUFBRSxFQUFFLENBQUM7b0JBQ3hELE1BQU0sSUFBSSxHQUFHLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQztvQkFDNUIsSUFBSSxDQUFDLElBQUk7d0JBQUUsU0FBUztvQkFFcEIsTUFBTSxFQUFFLEtBQUssRUFBRSxNQUFNLEVBQUUsR0FBRyxJQUFJLENBQUMsT0FBTyxFQUFFLENBQUM7b0JBQ3pDLE1BQU0sU0FBUyxHQUFHLElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxNQUFNLEVBQUUsSUFBSSxDQUFDLENBQUM7b0JBQ3pELElBQUksQ0FBQyxTQUFTO3dCQUFFLFNBQVM7b0JBRXpCLE1BQU0sUUFBUSxHQUFhLEVBQUUsQ0FBQztvQkFFOUIsS0FBSyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxHQUFHLFNBQVMsQ0FBQyxJQUFJLEVBQUUsRUFBRSxDQUFDLEVBQUUsRUFBRSxDQUFDO3dCQUMxQyxNQUFNLFFBQVEsR0FBRyxTQUFTLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDO3dCQUNsQyxNQUFNLEtBQUssR0FBRyxNQUFNLENBQUMsT0FBTyxDQUFDLFdBQVcsQ0FBQyxRQUFRLEVBQUUsT0FBTyxDQUFDLENBQUM7d0JBQzVELElBQUksQ0FBQyxLQUFLOzRCQUFFLFNBQVM7d0JBRXJCLGlCQUFpQjt3QkFDakIsSUFBSSxRQUFRLENBQUMsSUFBSSxHQUFHLENBQUMsRUFBRSxDQUFDOzRCQUN0QixNQUFNLEtBQUssR0FBRyxLQUFLLENBQUMsR0FBRyxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQzs0QkFDMUMsSUFBSSxLQUFLLFlBQVksU0FBUyxFQUFFLENBQUM7Z0NBQy9CLElBQUksT0FBTyxHQUFrQixJQUFJLENBQUM7Z0NBQ2xDLElBQUksQ0FBQztvQ0FDSCxPQUFPLEdBQUcsS0FBSyxDQUFDLFVBQVUsRUFBRSxDQUFDO2dDQUMvQixDQUFDO2dDQUFDLFdBQU0sQ0FBQztvQ0FDUCxPQUFPLEdBQUcsS0FBSyxDQUFDLFFBQVEsRUFBRSxDQUFDO2dDQUM3QixDQUFDO2dDQUNELElBQUksT0FBTyxLQUFLLElBQUksSUFBSSxRQUFRLENBQUMsR0FBRyxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7b0NBQzlDLFFBQVEsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7b0NBQ2pCLFNBQVM7Z0NBQ1gsQ0FBQzs0QkFDSCxDQUFDO3dCQUNILENBQUM7d0JBRUQsMkJBQTJCO3dCQUMzQixJQUFJLGNBQWMsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFLENBQUM7NEJBQzlCLE1BQU0sT0FBTyxHQUFHLEtBQUssQ0FBQyxHQUFHLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDOzRCQUNqRCxJQUFJLENBQUMsT0FBTyxJQUFJLE9BQU8sQ0FBQyxRQUFRLEVBQUUsS0FBSyxZQUFZO2dDQUFFLFNBQVM7NEJBRTlELE1BQU0sU0FBUyxHQUFHLEtBQUssQ0FBQyxHQUFHLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDOzRCQUNoRCxJQUFJLENBQUMsQ0FBQyxTQUFTLFlBQVksUUFBUSxDQUFDLElBQUksU0FBUyxDQUFDLElBQUksRUFBRSxLQUFLLENBQUM7Z0NBQzVELFNBQVM7NEJBRVgsTUFBTSxLQUFLLEdBQUksU0FBUyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQWUsQ0FBQyxRQUFRLEVBQUUsQ0FBQzs0QkFDekQsTUFBTSxLQUFLLEdBQUksU0FBUyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQWUsQ0FBQyxRQUFRLEVBQUUsQ0FBQzs0QkFDekQsTUFBTSxLQUFLLEdBQUksU0FBUyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQWUsQ0FBQyxRQUFRLEVBQUUsQ0FBQzs0QkFDekQsTUFBTSxLQUFLLEdBQUksU0FBUyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQWUsQ0FBQyxRQUFRLEVBQUUsQ0FBQzs0QkFFekQsTUFBTSxPQUFPLEdBQUcsT0FBTyxHQUFHLENBQUMsQ0FBQzs0QkFDNUIsS0FBSyxNQUFNLENBQUMsSUFBSSxjQUFjLEVBQUUsQ0FBQztnQ0FDL0IsSUFBSSxDQUFDLENBQUMsSUFBSSxLQUFLLE9BQU87b0NBQUUsU0FBUztnQ0FDakMsTUFBTSxTQUFTLEdBQUcsQ0FBQyxDQUFDO2dDQUNwQixNQUFNLEtBQUssR0FBRyxDQUFDLENBQUMsSUFBSSxDQUFDLEtBQUssR0FBRyxLQUFLLENBQUM7Z0NBQ25DLE1BQU0sS0FBSyxHQUFHLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxLQUFLLEdBQUcsQ0FBQyxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsR0FBRyxLQUFLLENBQUM7Z0NBQ3JELE1BQU0sS0FBSyxHQUFHLE1BQU0sR0FBRyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsSUFBSSxHQUFHLENBQUMsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLEdBQUcsTUFBTSxDQUFDO2dDQUMvRCxNQUFNLEtBQUssR0FBRyxNQUFNLEdBQUcsQ0FBQyxDQUFDLElBQUksQ0FBQyxJQUFJLEdBQUcsTUFBTSxDQUFDO2dDQUU1QyxJQUNFLElBQUksQ0FBQyxHQUFHLENBQUMsS0FBSyxFQUFFLEtBQUssR0FBRyxTQUFTLENBQUM7b0NBQ2hDLElBQUksQ0FBQyxHQUFHLENBQUMsS0FBSyxFQUFFLEtBQUssR0FBRyxTQUFTLENBQUM7b0NBQ3BDLElBQUksQ0FBQyxHQUFHLENBQUMsS0FBSyxFQUFFLEtBQUssR0FBRyxTQUFTLENBQUM7d0NBQ2hDLElBQUksQ0FBQyxHQUFHLENBQUMsS0FBSyxFQUFFLEtBQUssR0FBRyxTQUFTLENBQUMsRUFDcEMsQ0FBQztvQ0FDRCxRQUFRLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO29DQUNqQixNQUFNO2dDQUNSLENBQUM7NEJBQ0gsQ0FBQzt3QkFDSCxDQUFDO29CQUNILENBQUM7b0JBRUQsS0FBSyxJQUFJLENBQUMsR0FBRyxRQUFRLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsRUFBRSxFQUFFLENBQUM7d0JBQzlDLE1BQU0sR0FBRyxHQUFHLFFBQVEsQ0FBQyxDQUFDLENBQUUsQ0FBQzt3QkFDekIsTUFBTSxRQUFRLEdBQUcsU0FBUyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQzt3QkFDcEMsU0FBUyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQzt3QkFDdEIsSUFBSSxRQUFRLFlBQVksTUFBTSxFQUFFLENBQUM7NEJBQy9CLElBQUksQ0FBQztnQ0FDSCxNQUFNLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsQ0FBQzs0QkFDbEMsQ0FBQzs0QkFBQyxXQUFNLENBQUM7Z0NBQ1Asa0JBQWtCOzRCQUNwQixDQUFDO3dCQUNILENBQUM7b0JBQ0gsQ0FBQztnQkFDSCxDQUFDO1lBQ0gsQ0FBQztZQUVELHdFQUF3RTtZQUN4RSxLQUFLLE1BQU0sT0FBTyxJQUFJLFFBQVEsRUFBRSxDQUFDO2dCQUMvQixNQUFNLElBQUksR0FBRyxLQUFLLENBQUMsT0FBTyxDQUFDLFVBQVUsR0FBRyxDQUFDLENBQUMsQ0FBQztnQkFDM0MsSUFBSSxDQUFDLElBQUk7b0JBQUUsU0FBUztnQkFFcEIsTUFBTSxFQUFFLEtBQUssRUFBRSxNQUFNLEVBQUUsR0FBRyxJQUFJLENBQUMsT0FBTyxFQUFFLENBQUM7Z0JBQ3pDLE1BQU0sY0FBYyxHQUFhLEVBQUUsQ0FBQztnQkFDcEMsSUFBSSxJQUFJLEdBQUcsUUFBUSxFQUNqQixJQUFJLEdBQUcsUUFBUSxFQUNmLElBQUksR0FBRyxDQUFDLFFBQVEsRUFDaEIsSUFBSSxHQUFHLENBQUMsUUFBUSxDQUFDO2dCQUVuQixLQUFLLE1BQU0sQ0FBQyxJQUFJLE9BQU8sQ0FBQyxLQUFLLEVBQUUsQ0FBQztvQkFDOUIsTUFBTSxLQUFLLEdBQUcsQ0FBQyxDQUFDLEtBQUssR0FBRyxLQUFLLENBQUM7b0JBQzlCLE1BQU0sS0FBSyxHQUFHLENBQUMsQ0FBQyxDQUFDLEtBQUssR0FBRyxDQUFDLENBQUMsTUFBTSxDQUFDLEdBQUcsS0FBSyxDQUFDO29CQUMzQyxNQUFNLEtBQUssR0FBRyxNQUFNLEdBQUcsQ0FBQyxDQUFDLENBQUMsSUFBSSxHQUFHLENBQUMsQ0FBQyxPQUFPLENBQUMsR0FBRyxNQUFNLENBQUM7b0JBQ3JELE1BQU0sS0FBSyxHQUFHLE1BQU0sR0FBRyxDQUFDLENBQUMsSUFBSSxHQUFHLE1BQU0sQ0FBQztvQkFFdkMsY0FBYyxDQUFDLElBQUksQ0FDakIsS0FBSyxFQUNMLEtBQUssRUFDTCxLQUFLLEVBQ0wsS0FBSyxFQUNMLEtBQUssRUFDTCxLQUFLLEVBQ0wsS0FBSyxFQUNMLEtBQUssQ0FDTixDQUFDO29CQUNGLElBQUksR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLElBQUksRUFBRSxLQUFLLENBQUMsQ0FBQztvQkFDN0IsSUFBSSxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsSUFBSSxFQUFFLEtBQUssQ0FBQyxDQUFDO29CQUM3QixJQUFJLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxJQUFJLEVBQUUsS0FBSyxDQUFDLENBQUM7b0JBQzdCLElBQUksR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLElBQUksRUFBRSxLQUFLLENBQUMsQ0FBQztnQkFDL0IsQ0FBQztnQkFFRCxNQUFNLG1CQUFtQixHQUFHLE1BQU0sQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDO29CQUM3QyxJQUFJLEVBQUUsT0FBTztvQkFDYixPQUFPLEVBQUUsV0FBVztvQkFDcEIsRUFBRSxFQUFFLFNBQVMsQ0FBQyxFQUFFLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQztvQkFDNUIsSUFBSSxFQUFFLENBQUMsSUFBSSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsSUFBSSxDQUFDO29CQUM5QixVQUFVLEVBQUUsY0FBYztvQkFDMUIsQ0FBQyxFQUFFLE9BQU8sQ0FBQyxRQUFRO29CQUNuQixFQUFFLEVBQUUsT0FBTyxDQUFDLE9BQU87b0JBQ25CLENBQUMsRUFBRSxTQUFTLENBQUMsRUFBRSxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUM7b0JBQy9CLFlBQVksRUFBRSxTQUFTLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxjQUFjLEVBQUUsQ0FBQztvQkFDakQsQ0FBQyxFQUFFLFNBQVMsQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFDLGNBQWMsRUFBRSxDQUFDO29CQUN0QyxDQUFDLEVBQUUsQ0FBQztpQkFDTCxDQUFDLENBQUM7Z0JBRUgsTUFBTSxhQUFhLEdBQUcsTUFBTSxDQUFDLE9BQU8sQ0FBQyxRQUFRLENBQUMsbUJBQW1CLENBQUMsQ0FBQztnQkFDbkUsSUFBSSxTQUFTLEdBQUcsSUFBSSxDQUFDLG1CQUFtQixDQUFDLE1BQU0sRUFBRSxJQUFJLENBQUMsQ0FBQztnQkFDdkQsSUFBSSxDQUFDLFNBQVMsRUFBRSxDQUFDO29CQUNmLFFBQVE7b0JBQ1IsTUFBTSxNQUFNLEdBQUcsTUFBTSxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFhLENBQUM7b0JBQ2xELElBQUksQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUMsUUFBUSxDQUFDLEVBQUUsTUFBTSxDQUFDLENBQUM7b0JBQzVDLFNBQVMsR0FBRyxNQUFNLENBQUM7Z0JBQ3JCLENBQUM7Z0JBQ0QsU0FBUyxDQUFDLElBQUksQ0FBQyxhQUFhLENBQUMsQ0FBQztZQUNoQyxDQUFDO1lBRUQsd0VBQXdFO1lBQ3hFLElBQUksQ0FBQztnQkFDSCxNQUFNLGdCQUFnQixHQUFHLE1BQU0sTUFBTSxDQUFDLElBQUksRUFBRSxDQUFDO2dCQUM3QyxNQUFNLElBQUksQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLFlBQVksQ0FDL0IsSUFBSSxFQUNKLGdCQUFnQixDQUFDLE1BQXFCLENBQ3ZDLENBQUM7WUFDSixDQUFDO1lBQUMsV0FBTSxDQUFDO2dCQUNQLGdEQUFnRDtnQkFDaEQsTUFBTSxJQUFJLGNBQWMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7WUFDdEMsQ0FBQztRQUNILENBQUM7S0FBQTtJQUVELDZFQUE2RTtJQUUvRCxtQkFBbUIsQ0FDL0IsS0FBa0IsRUFDbEIsUUFBZ0I7OztZQUVoQixJQUFJLENBQUM7Z0JBQ0gsTUFBTSxXQUFXLENBQUMsSUFBSSxDQUFDLEtBQUssRUFBRTtvQkFDNUIsY0FBYyxFQUFFLEtBQUs7b0JBQ3JCLGdCQUFnQixFQUFFLEtBQUs7aUJBQ3hCLENBQUMsQ0FBQztZQUNMLENBQUM7WUFBQyxPQUFPLENBQU0sRUFBRSxDQUFDO2dCQUNoQixJQUNFLENBQUEsQ0FBQyxhQUFELENBQUMsdUJBQUQsQ0FBQyxDQUFFLElBQUksTUFBSyxtQkFBbUI7cUJBQy9CLE1BQUEsQ0FBQyxhQUFELENBQUMsdUJBQUQsQ0FBQyxDQUFFLE9BQU8sMENBQUUsV0FBVyxHQUFHLFFBQVEsQ0FBQyxTQUFTLENBQUMsQ0FBQSxFQUM3QyxDQUFDO29CQUNELE1BQU0sSUFBSSxpQkFBaUIsQ0FBQyxRQUFRLENBQUMsQ0FBQztnQkFDeEMsQ0FBQztZQUNILENBQUM7UUFDSCxDQUFDO0tBQUE7SUFFTyxtQkFBbUIsQ0FDekIsTUFBbUIsRUFDbkIsSUFBaUQ7UUFFakQsTUFBTSxTQUFTLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxNQUFNLEVBQUUsQ0FBQztRQUNyQyxJQUFJLENBQUMsU0FBUztZQUFFLE9BQU8sSUFBSSxDQUFDO1FBQzVCLE1BQU0sUUFBUSxHQUFHLE1BQU0sQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLFNBQVMsQ0FBQyxDQUFDO1FBQ2xELElBQUksUUFBUSxZQUFZLFFBQVE7WUFBRSxPQUFPLFFBQVEsQ0FBQztRQUNsRCxPQUFPLElBQUksQ0FBQztJQUNkLENBQUM7SUFFTyxlQUFlLENBQUMsRUFBVTs7UUFDaEMsTUFBTSxLQUFLLEdBQUcsRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUM1QixNQUFNLE9BQU8sR0FBRyxRQUFRLENBQUMsTUFBQSxLQUFLLENBQUMsQ0FBQyxDQUFDLG1DQUFJLEdBQUcsRUFBRSxFQUFFLENBQUMsQ0FBQztRQUM5QyxNQUFNLFNBQVMsR0FBRyxDQUFDLE1BQUEsS0FBSyxDQUFDLENBQUMsQ0FBQyxtQ0FBSSxTQUFTLENBQUMsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxDQUFDO1FBQ2pFLE9BQU87WUFDTCxJQUFJLEVBQUUsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU87WUFDbEMsSUFBSSxFQUFFO2dCQUNKLEtBQUssRUFBRSxNQUFBLFNBQVMsQ0FBQyxDQUFDLENBQUMsbUNBQUksQ0FBQztnQkFDeEIsSUFBSSxFQUFFLE1BQUEsU0FBUyxDQUFDLENBQUMsQ0FBQyxtQ0FBSSxDQUFDO2dCQUN2QixNQUFNLEVBQUUsTUFBQSxTQUFTLENBQUMsQ0FBQyxDQUFDLG1DQUFJLENBQUM7Z0JBQ3pCLE9BQU8sRUFBRSxNQUFBLFNBQVMsQ0FBQyxDQUFDLENBQUMsbUNBQUksQ0FBQzthQUMzQjtTQUNGLENBQUM7SUFDSixDQUFDO0lBRU8sY0FBYztRQUNwQixNQUFNLEdBQUcsR0FBRyxJQUFJLElBQUksRUFBRSxDQUFDO1FBQ3ZCLE1BQU0sR0FBRyxHQUFHLENBQUMsQ0FBUyxFQUFFLENBQUMsR0FBRyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxRQUFRLEVBQUUsQ0FBQyxRQUFRLENBQUMsQ0FBQyxFQUFFLEdBQUcsQ0FBQyxDQUFDO1FBQ2hFLE1BQU0sU0FBUyxHQUFHLENBQUMsR0FBRyxDQUFDLGlCQUFpQixFQUFFLENBQUM7UUFDM0MsTUFBTSxJQUFJLEdBQUcsU0FBUyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUM7UUFDeEMsTUFBTSxNQUFNLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxTQUFTLENBQUMsQ0FBQztRQUNuQyxPQUFPLENBQ0wsS0FBSyxHQUFHLENBQUMsV0FBVyxFQUFFLEdBQUcsR0FBRyxDQUFDLEdBQUcsQ0FBQyxRQUFRLEVBQUUsR0FBRyxDQUFDLENBQUMsR0FBRyxHQUFHLENBQUMsR0FBRyxDQUFDLE9BQU8sRUFBRSxDQUFDLEVBQUU7WUFDdkUsR0FBRyxHQUFHLENBQUMsR0FBRyxDQUFDLFFBQVEsRUFBRSxDQUFDLEdBQUcsR0FBRyxDQUFDLEdBQUcsQ0FBQyxVQUFVLEVBQUUsQ0FBQyxHQUFHLEdBQUcsQ0FBQyxHQUFHLENBQUMsVUFBVSxFQUFFLENBQUMsRUFBRTtZQUN4RSxHQUFHLElBQUksR0FBRyxHQUFHLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNLEdBQUcsRUFBRSxDQUFDLENBQUMsSUFBSSxHQUFHLENBQUMsTUFBTSxHQUFHLEVBQUUsQ0FBQyxHQUFHLENBQzlELENBQUM7SUFDSixDQUFDO0NBQ0Y7QUFDRCxVQUFVIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgQXBwLCBURmlsZSB9IGZyb20gXCJvYnNpZGlhblwiO1xuaW1wb3J0IHtcbiAgUERGRG9jdW1lbnQsXG4gIFBERlN0cmluZyxcbiAgUERGTmFtZSxcbiAgUERGRGljdCxcbiAgUERGQXJyYXksXG4gIFBERlJlZixcbiAgUERGTnVtYmVyLFxufSBmcm9tIFwicGRmLWxpYlwiO1xuaW1wb3J0IHsgUmVjdE92ZXJsYXkgfSBmcm9tIFwiLi4vaGlnaGxpZ2h0L1NlbGVjdGlvbkV4dHJhY3RvclwiO1xuXG5leHBvcnQgaW50ZXJmYWNlIFBkZkhpZ2hsaWdodFBheWxvYWQge1xuICBwYWdlTnVtYmVyOiBudW1iZXI7XG4gIHJlY3RzOiBSZWN0T3ZlcmxheVtdO1xuICBjb2xvclJnYjogW251bWJlciwgbnVtYmVyLCBudW1iZXJdO1xuICBvcGFjaXR5OiBudW1iZXI7XG4gIGF1dGhvcjogc3RyaW5nO1xuICBpZDogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFNhdmVkQW5ub3RhdGlvbkluZm8ge1xuICBpZDogc3RyaW5nIHwgbnVsbDtcbiAgcGFnZU51bWJlcjogbnVtYmVyO1xuICBwTGVmdDogbnVtYmVyO1xuICBwVG9wOiBudW1iZXI7XG4gIHBXaWR0aDogbnVtYmVyO1xuICBwSGVpZ2h0OiBudW1iZXI7XG59XG5cbmV4cG9ydCBjbGFzcyBFbmNyeXB0ZWRQZGZFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IoZmlsZU5hbWU6IHN0cmluZykge1xuICAgIHN1cGVyKGBcIiR7ZmlsZU5hbWV9XCIgaXMgcGFzc3dvcmQtcHJvdGVjdGVkIGFuZCBjYW5ub3QgYmUgYW5ub3RhdGVkLmApO1xuICAgIHRoaXMubmFtZSA9IFwiRW5jcnlwdGVkUGRmRXJyb3JcIjtcbiAgfVxufVxuXG5leHBvcnQgY2xhc3MgTG9ja2VkUGRmRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKGZpbGVOYW1lOiBzdHJpbmcpIHtcbiAgICBzdXBlcihgXCIke2ZpbGVOYW1lfVwiIGlzIGxvY2tlZCBieSBhbm90aGVyIGFwcGxpY2F0aW9uLmApO1xuICAgIHRoaXMubmFtZSA9IFwiTG9ja2VkUGRmRXJyb3JcIjtcbiAgfVxufVxuXG5leHBvcnQgY2xhc3MgUGRmQW5ub3RhdG9yIHtcbiAgYXBwOiBBcHA7XG5cbiAgY29uc3RydWN0b3IoYXBwOiBBcHApIHtcbiAgICB0aGlzLmFwcCA9IGFwcDtcbiAgfVxuXG4gIC8vIOKUgOKUgCBSZWFkIGFsbCBleGlzdGluZyBIaWdobGlnaHQgYW5ub3RhdGlvbnMgZnJvbSB0aGUgUERGIGJpbmFyeSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgYXN5bmMgcmVhZEFubm90YXRpb25zRnJvbVBkZihmaWxlOiBURmlsZSk6IFByb21pc2U8U2F2ZWRBbm5vdGF0aW9uSW5mb1tdPiB7XG4gICAgY29uc3QgcmVzdWx0czogU2F2ZWRBbm5vdGF0aW9uSW5mb1tdID0gW107XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGJ5dGVzID0gYXdhaXQgdGhpcy5hcHAudmF1bHQucmVhZEJpbmFyeShmaWxlKTtcblxuICAgICAgLy8gQ2hlY2sgZm9yIGVuY3J5cHRpb24gQkVGT1JFIGxvYWRpbmcgd2l0aCBpZ25vcmVFbmNyeXB0aW9uXG4gICAgICAvLyBzbyB3ZSBjYW4gc3VyZmFjZSBhIG1lYW5pbmdmdWwgZXJyb3IgdG8gdGhlIGNhbGxlci5cbiAgICAgIGF3YWl0IHRoaXMuX2Fzc2VydE5vdEVuY3J5cHRlZChieXRlcywgZmlsZS5uYW1lKTtcblxuICAgICAgY29uc3QgcGRmRG9jID0gYXdhaXQgUERGRG9jdW1lbnQubG9hZChieXRlcywge1xuICAgICAgICB1cGRhdGVNZXRhZGF0YTogZmFsc2UsXG4gICAgICAgIGlnbm9yZUVuY3J5cHRpb246IGZhbHNlLFxuICAgICAgfSk7XG5cbiAgICAgIGNvbnN0IHBhZ2VzID0gcGRmRG9jLmdldFBhZ2VzKCk7XG4gICAgICBmb3IgKGxldCBwYWdlSWR4ID0gMDsgcGFnZUlkeCA8IHBhZ2VzLmxlbmd0aDsgcGFnZUlkeCsrKSB7XG4gICAgICAgIGNvbnN0IHBhZ2UgPSBwYWdlc1twYWdlSWR4XTtcbiAgICAgICAgaWYgKCFwYWdlKSBjb250aW51ZTtcblxuICAgICAgICBjb25zdCB7IHdpZHRoLCBoZWlnaHQgfSA9IHBhZ2UuZ2V0U2l6ZSgpO1xuICAgICAgICBjb25zdCBhbm5vdHNPYmogPSB0aGlzLl9yZXNvbHZlQW5ub3RzQXJyYXkocGRmRG9jLCBwYWdlKTtcbiAgICAgICAgaWYgKCFhbm5vdHNPYmopIGNvbnRpbnVlO1xuXG4gICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYW5ub3RzT2JqLnNpemUoKTsgaSsrKSB7XG4gICAgICAgICAgY29uc3QgYW5ub3RSZWYgPSBhbm5vdHNPYmouZ2V0KGkpO1xuICAgICAgICAgIGNvbnN0IGFubm90ID0gcGRmRG9jLmNvbnRleHQubG9va3VwTWF5YmUoYW5ub3RSZWYsIFBERkRpY3QpO1xuICAgICAgICAgIGlmICghYW5ub3QpIGNvbnRpbnVlO1xuXG4gICAgICAgICAgY29uc3Qgc3VidHlwZSA9IGFubm90LmdldChQREZOYW1lLm9mKFwiU3VidHlwZVwiKSk7XG4gICAgICAgICAgaWYgKCFzdWJ0eXBlIHx8IHN1YnR5cGUudG9TdHJpbmcoKSAhPT0gXCIvSGlnaGxpZ2h0XCIpIGNvbnRpbnVlO1xuXG4gICAgICAgICAgbGV0IGlkOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICAgICAgICBjb25zdCBubU9iaiA9IGFubm90LmdldChQREZOYW1lLm9mKFwiTk1cIikpO1xuICAgICAgICAgIGlmIChubU9iaiBpbnN0YW5jZW9mIFBERlN0cmluZykge1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgaWQgPSBubU9iai5kZWNvZGVUZXh0KCk7XG4gICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgaWQgPSBubU9iai5hc1N0cmluZygpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cblxuICAgICAgICAgIGNvbnN0IHJlY3RBcnJheSA9IGFubm90LmdldChQREZOYW1lLm9mKFwiUmVjdFwiKSk7XG4gICAgICAgICAgaWYgKCEocmVjdEFycmF5IGluc3RhbmNlb2YgUERGQXJyYXkpIHx8IHJlY3RBcnJheS5zaXplKCkgIT09IDQpXG4gICAgICAgICAgICBjb250aW51ZTtcblxuICAgICAgICAgIGNvbnN0IG1pblggPSAocmVjdEFycmF5LmdldCgwKSBhcyBQREZOdW1iZXIpLmFzTnVtYmVyKCk7XG4gICAgICAgICAgY29uc3QgbWluWSA9IChyZWN0QXJyYXkuZ2V0KDEpIGFzIFBERk51bWJlcikuYXNOdW1iZXIoKTtcbiAgICAgICAgICBjb25zdCBtYXhYID0gKHJlY3RBcnJheS5nZXQoMikgYXMgUERGTnVtYmVyKS5hc051bWJlcigpO1xuICAgICAgICAgIGNvbnN0IG1heFkgPSAocmVjdEFycmF5LmdldCgzKSBhcyBQREZOdW1iZXIpLmFzTnVtYmVyKCk7XG5cbiAgICAgICAgICByZXN1bHRzLnB1c2goe1xuICAgICAgICAgICAgaWQsXG4gICAgICAgICAgICBwYWdlTnVtYmVyOiBwYWdlSWR4ICsgMSxcbiAgICAgICAgICAgIHBMZWZ0OiBtaW5YIC8gd2lkdGgsXG4gICAgICAgICAgICBwVG9wOiAxIC0gbWF4WSAvIGhlaWdodCxcbiAgICAgICAgICAgIHBXaWR0aDogKG1heFggLSBtaW5YKSAvIHdpZHRoLFxuICAgICAgICAgICAgcEhlaWdodDogKG1heFkgLSBtaW5ZKSAvIGhlaWdodCxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIC8vIFJlLXRocm93IG91ciB0eXBlZCBlcnJvcnM7IHN3YWxsb3cgZXZlcnl0aGluZyBlbHNlXG4gICAgICBpZiAoZSBpbnN0YW5jZW9mIEVuY3J5cHRlZFBkZkVycm9yKSB0aHJvdyBlO1xuICAgICAgY29uc29sZS5lcnJvcihcIltBbm5vdGF0ZVBERl0gcmVhZEFubm90YXRpb25zRnJvbVBkZiBmYWlsZWQ6XCIsIGUpO1xuICAgIH1cbiAgICByZXR1cm4gcmVzdWx0cztcbiAgfVxuXG4gIC8vIOKUgOKUgCBXcml0ZSBhZGRpdGlvbnMgKyBkZWxldGlvbnMgdG8gdGhlIFBERiBpbiBvbmUgYXRvbWljIHBhc3Mg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIGFzeW5jIGFwcGx5QmF0Y2hVcGRhdGVzVG9QZGYoXG4gICAgZmlsZTogVEZpbGUsXG4gICAgcGF5bG9hZHM6IFBkZkhpZ2hsaWdodFBheWxvYWRbXSxcbiAgICBkZWxldGlvbklkczogc3RyaW5nW10sXG4gICk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmIChwYXlsb2Fkcy5sZW5ndGggPT09IDAgJiYgZGVsZXRpb25JZHMubGVuZ3RoID09PSAwKSByZXR1cm47XG5cbiAgICBjb25zdCBmaWxlQ29udGVudCA9IGF3YWl0IHRoaXMuYXBwLnZhdWx0LnJlYWRCaW5hcnkoZmlsZSk7XG5cbiAgICAvLyDilIDilIAgRW5jcnlwdGlvbiBjaGVjayDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgICAvLyBNdXN0IGhhcHBlbiBiZWZvcmUgd2UgdHJ5IHRvIGxvYWQgKyBzYXZlLCBvdGhlcndpc2UgcGRmLWxpYiB0aHJvd3NcbiAgICAvLyBhIGdlbmVyaWMgRW5jcnlwdGVkUERGRXJyb3IgdGhhdCBsb29rcyBpZGVudGljYWwgdG8gYSBwYXJzZSBmYWlsdXJlLlxuICAgIGF3YWl0IHRoaXMuX2Fzc2VydE5vdEVuY3J5cHRlZChmaWxlQ29udGVudCwgZmlsZS5uYW1lKTtcblxuICAgIGxldCBwZGZEb2M6IFBERkRvY3VtZW50O1xuICAgIHRyeSB7XG4gICAgICBwZGZEb2MgPSBhd2FpdCBQREZEb2N1bWVudC5sb2FkKGZpbGVDb250ZW50LCB7XG4gICAgICAgIHVwZGF0ZU1ldGFkYXRhOiBmYWxzZSxcbiAgICAgICAgaWdub3JlRW5jcnlwdGlvbjogZmFsc2UsXG4gICAgICB9KTtcbiAgICB9IGNhdGNoIChlOiBhbnkpIHtcbiAgICAgIC8vIHBkZi1saWIncyBvd24gRW5jcnlwdGVkUERGRXJyb3IgKGJlbHQtYW5kLXN1c3BlbmRlcnMgY2F0Y2gpXG4gICAgICBpZiAoXG4gICAgICAgIGU/Lm5hbWUgPT09IFwiRW5jcnlwdGVkUERGRXJyb3JcIiB8fFxuICAgICAgICBlPy5tZXNzYWdlPy5pbmNsdWRlcyhcImVuY3J5cHRlZFwiKVxuICAgICAgKSB7XG4gICAgICAgIHRocm93IG5ldyBFbmNyeXB0ZWRQZGZFcnJvcihmaWxlLm5hbWUpO1xuICAgICAgfVxuICAgICAgLy8gQW55dGhpbmcgZWxzZSBpcyBsaWtlbHkgYSBmaWxlLWxvY2sgLyBjb3JydXB0aW9uIOKAlCB0cmVhdCBhcyByZXRyeWFibGVcbiAgICAgIHRocm93IG5ldyBMb2NrZWRQZGZFcnJvcihmaWxlLm5hbWUpO1xuICAgIH1cblxuICAgIGNvbnN0IHBhZ2VzID0gcGRmRG9jLmdldFBhZ2VzKCk7XG5cbiAgICAvLyDilIDilIAgRGVsZXRpb25zIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAgIGlmIChkZWxldGlvbklkcy5sZW5ndGggPiAwKSB7XG4gICAgICBjb25zdCBleGFjdElkcyA9IG5ldyBTZXQoXG4gICAgICAgIGRlbGV0aW9uSWRzLmZpbHRlcigoaWQpID0+ICFpZC5zdGFydHNXaXRoKFwiU1BBVElBTDpcIikpLFxuICAgICAgKTtcbiAgICAgIGNvbnN0IHNwYXRpYWxUYXJnZXRzID0gZGVsZXRpb25JZHNcbiAgICAgICAgLmZpbHRlcigoaWQpID0+IGlkLnN0YXJ0c1dpdGgoXCJTUEFUSUFMOlwiKSlcbiAgICAgICAgLm1hcCgoaWQpID0+IHRoaXMuX3BhcnNlU3BhdGlhbElkKGlkKSk7XG5cbiAgICAgIGZvciAobGV0IHBhZ2VJZHggPSAwOyBwYWdlSWR4IDwgcGFnZXMubGVuZ3RoOyBwYWdlSWR4KyspIHtcbiAgICAgICAgY29uc3QgcGFnZSA9IHBhZ2VzW3BhZ2VJZHhdO1xuICAgICAgICBpZiAoIXBhZ2UpIGNvbnRpbnVlO1xuXG4gICAgICAgIGNvbnN0IHsgd2lkdGgsIGhlaWdodCB9ID0gcGFnZS5nZXRTaXplKCk7XG4gICAgICAgIGNvbnN0IGFubm90c09iaiA9IHRoaXMuX3Jlc29sdmVBbm5vdHNBcnJheShwZGZEb2MsIHBhZ2UpO1xuICAgICAgICBpZiAoIWFubm90c09iaikgY29udGludWU7XG5cbiAgICAgICAgY29uc3QgdG9EZWxldGU6IG51bWJlcltdID0gW107XG5cbiAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBhbm5vdHNPYmouc2l6ZSgpOyBpKyspIHtcbiAgICAgICAgICBjb25zdCBhbm5vdFJlZiA9IGFubm90c09iai5nZXQoaSk7XG4gICAgICAgICAgY29uc3QgYW5ub3QgPSBwZGZEb2MuY29udGV4dC5sb29rdXBNYXliZShhbm5vdFJlZiwgUERGRGljdCk7XG4gICAgICAgICAgaWYgKCFhbm5vdCkgY29udGludWU7XG5cbiAgICAgICAgICAvLyBFeGFjdCBOTSBtYXRjaFxuICAgICAgICAgIGlmIChleGFjdElkcy5zaXplID4gMCkge1xuICAgICAgICAgICAgY29uc3Qgbm1PYmogPSBhbm5vdC5nZXQoUERGTmFtZS5vZihcIk5NXCIpKTtcbiAgICAgICAgICAgIGlmIChubU9iaiBpbnN0YW5jZW9mIFBERlN0cmluZykge1xuICAgICAgICAgICAgICBsZXQgbm1WYWx1ZTogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgbm1WYWx1ZSA9IG5tT2JqLmRlY29kZVRleHQoKTtcbiAgICAgICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAgICAgbm1WYWx1ZSA9IG5tT2JqLmFzU3RyaW5nKCk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgaWYgKG5tVmFsdWUgIT09IG51bGwgJiYgZXhhY3RJZHMuaGFzKG5tVmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgdG9EZWxldGUucHVzaChpKTtcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cblxuICAgICAgICAgIC8vIFNwYXRpYWwgb3ZlcmxhcCBmYWxsYmFja1xuICAgICAgICAgIGlmIChzcGF0aWFsVGFyZ2V0cy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBjb25zdCBzdWJ0eXBlID0gYW5ub3QuZ2V0KFBERk5hbWUub2YoXCJTdWJ0eXBlXCIpKTtcbiAgICAgICAgICAgIGlmICghc3VidHlwZSB8fCBzdWJ0eXBlLnRvU3RyaW5nKCkgIT09IFwiL0hpZ2hsaWdodFwiKSBjb250aW51ZTtcblxuICAgICAgICAgICAgY29uc3QgcmVjdEFycmF5ID0gYW5ub3QuZ2V0KFBERk5hbWUub2YoXCJSZWN0XCIpKTtcbiAgICAgICAgICAgIGlmICghKHJlY3RBcnJheSBpbnN0YW5jZW9mIFBERkFycmF5KSB8fCByZWN0QXJyYXkuc2l6ZSgpICE9PSA0KVxuICAgICAgICAgICAgICBjb250aW51ZTtcblxuICAgICAgICAgICAgY29uc3QgYU1pblggPSAocmVjdEFycmF5LmdldCgwKSBhcyBQREZOdW1iZXIpLmFzTnVtYmVyKCk7XG4gICAgICAgICAgICBjb25zdCBhTWluWSA9IChyZWN0QXJyYXkuZ2V0KDEpIGFzIFBERk51bWJlcikuYXNOdW1iZXIoKTtcbiAgICAgICAgICAgIGNvbnN0IGFNYXhYID0gKHJlY3RBcnJheS5nZXQoMikgYXMgUERGTnVtYmVyKS5hc051bWJlcigpO1xuICAgICAgICAgICAgY29uc3QgYU1heFkgPSAocmVjdEFycmF5LmdldCgzKSBhcyBQREZOdW1iZXIpLmFzTnVtYmVyKCk7XG5cbiAgICAgICAgICAgIGNvbnN0IHBhZ2VOdW0gPSBwYWdlSWR4ICsgMTtcbiAgICAgICAgICAgIGZvciAoY29uc3QgcyBvZiBzcGF0aWFsVGFyZ2V0cykge1xuICAgICAgICAgICAgICBpZiAocy5wYWdlICE9PSBwYWdlTnVtKSBjb250aW51ZTtcbiAgICAgICAgICAgICAgY29uc3QgVE9MRVJBTkNFID0gMjtcbiAgICAgICAgICAgICAgY29uc3Qgc01pblggPSBzLnJlY3QucExlZnQgKiB3aWR0aDtcbiAgICAgICAgICAgICAgY29uc3Qgc01heFggPSAocy5yZWN0LnBMZWZ0ICsgcy5yZWN0LnBXaWR0aCkgKiB3aWR0aDtcbiAgICAgICAgICAgICAgY29uc3Qgc01pblkgPSBoZWlnaHQgLSAocy5yZWN0LnBUb3AgKyBzLnJlY3QucEhlaWdodCkgKiBoZWlnaHQ7XG4gICAgICAgICAgICAgIGNvbnN0IHNNYXhZID0gaGVpZ2h0IC0gcy5yZWN0LnBUb3AgKiBoZWlnaHQ7XG5cbiAgICAgICAgICAgICAgaWYgKFxuICAgICAgICAgICAgICAgIE1hdGgubWF4KGFNaW5YLCBzTWluWCAtIFRPTEVSQU5DRSkgPFxuICAgICAgICAgICAgICAgICAgTWF0aC5taW4oYU1heFgsIHNNYXhYICsgVE9MRVJBTkNFKSAmJlxuICAgICAgICAgICAgICAgIE1hdGgubWF4KGFNaW5ZLCBzTWluWSAtIFRPTEVSQU5DRSkgPFxuICAgICAgICAgICAgICAgICAgTWF0aC5taW4oYU1heFksIHNNYXhZICsgVE9MRVJBTkNFKVxuICAgICAgICAgICAgICApIHtcbiAgICAgICAgICAgICAgICB0b0RlbGV0ZS5wdXNoKGkpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgZm9yIChsZXQgayA9IHRvRGVsZXRlLmxlbmd0aCAtIDE7IGsgPj0gMDsgay0tKSB7XG4gICAgICAgICAgY29uc3QgaWR4ID0gdG9EZWxldGVba10hO1xuICAgICAgICAgIGNvbnN0IGFubm90UmVmID0gYW5ub3RzT2JqLmdldChpZHgpO1xuICAgICAgICAgIGFubm90c09iai5yZW1vdmUoaWR4KTtcbiAgICAgICAgICBpZiAoYW5ub3RSZWYgaW5zdGFuY2VvZiBQREZSZWYpIHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIHBkZkRvYy5jb250ZXh0LmRlbGV0ZShhbm5vdFJlZik7XG4gICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgLyogYWxyZWFkeSBnb25lICovXG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8g4pSA4pSAIEFkZGl0aW9ucyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgICBmb3IgKGNvbnN0IHBheWxvYWQgb2YgcGF5bG9hZHMpIHtcbiAgICAgIGNvbnN0IHBhZ2UgPSBwYWdlc1twYXlsb2FkLnBhZ2VOdW1iZXIgLSAxXTtcbiAgICAgIGlmICghcGFnZSkgY29udGludWU7XG5cbiAgICAgIGNvbnN0IHsgd2lkdGgsIGhlaWdodCB9ID0gcGFnZS5nZXRTaXplKCk7XG4gICAgICBjb25zdCBxdWFkUG9pbnRzTGlzdDogbnVtYmVyW10gPSBbXTtcbiAgICAgIGxldCBtaW5YID0gSW5maW5pdHksXG4gICAgICAgIG1pblkgPSBJbmZpbml0eSxcbiAgICAgICAgbWF4WCA9IC1JbmZpbml0eSxcbiAgICAgICAgbWF4WSA9IC1JbmZpbml0eTtcblxuICAgICAgZm9yIChjb25zdCByIG9mIHBheWxvYWQucmVjdHMpIHtcbiAgICAgICAgY29uc3Qgck1pblggPSByLnBMZWZ0ICogd2lkdGg7XG4gICAgICAgIGNvbnN0IHJNYXhYID0gKHIucExlZnQgKyByLnBXaWR0aCkgKiB3aWR0aDtcbiAgICAgICAgY29uc3Qgck1pblkgPSBoZWlnaHQgLSAoci5wVG9wICsgci5wSGVpZ2h0KSAqIGhlaWdodDtcbiAgICAgICAgY29uc3Qgck1heFkgPSBoZWlnaHQgLSByLnBUb3AgKiBoZWlnaHQ7XG5cbiAgICAgICAgcXVhZFBvaW50c0xpc3QucHVzaChcbiAgICAgICAgICByTWluWCxcbiAgICAgICAgICByTWF4WSxcbiAgICAgICAgICByTWF4WCxcbiAgICAgICAgICByTWF4WSxcbiAgICAgICAgICByTWluWCxcbiAgICAgICAgICByTWluWSxcbiAgICAgICAgICByTWF4WCxcbiAgICAgICAgICByTWluWSxcbiAgICAgICAgKTtcbiAgICAgICAgbWluWCA9IE1hdGgubWluKG1pblgsIHJNaW5YKTtcbiAgICAgICAgbWF4WCA9IE1hdGgubWF4KG1heFgsIHJNYXhYKTtcbiAgICAgICAgbWluWSA9IE1hdGgubWluKG1pblksIHJNaW5ZKTtcbiAgICAgICAgbWF4WSA9IE1hdGgubWF4KG1heFksIHJNYXhZKTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgaGlnaGxpZ2h0QW5ub3RhdGlvbiA9IHBkZkRvYy5jb250ZXh0Lm9iaih7XG4gICAgICAgIFR5cGU6IFwiQW5ub3RcIixcbiAgICAgICAgU3VidHlwZTogXCJIaWdobGlnaHRcIixcbiAgICAgICAgTk06IFBERlN0cmluZy5vZihwYXlsb2FkLmlkKSxcbiAgICAgICAgUmVjdDogW21pblgsIG1pblksIG1heFgsIG1heFldLFxuICAgICAgICBRdWFkUG9pbnRzOiBxdWFkUG9pbnRzTGlzdCxcbiAgICAgICAgQzogcGF5bG9hZC5jb2xvclJnYixcbiAgICAgICAgQ0E6IHBheWxvYWQub3BhY2l0eSxcbiAgICAgICAgVDogUERGU3RyaW5nLm9mKHBheWxvYWQuYXV0aG9yKSxcbiAgICAgICAgQ3JlYXRpb25EYXRlOiBQREZTdHJpbmcub2YodGhpcy5fcGRmRGF0ZVN0cmluZygpKSxcbiAgICAgICAgTTogUERGU3RyaW5nLm9mKHRoaXMuX3BkZkRhdGVTdHJpbmcoKSksXG4gICAgICAgIEY6IDQsXG4gICAgICB9KTtcblxuICAgICAgY29uc3QgYW5ub3RhdGlvblJlZiA9IHBkZkRvYy5jb250ZXh0LnJlZ2lzdGVyKGhpZ2hsaWdodEFubm90YXRpb24pO1xuICAgICAgbGV0IGFubm90c09iaiA9IHRoaXMuX3Jlc29sdmVBbm5vdHNBcnJheShwZGZEb2MsIHBhZ2UpO1xuICAgICAgaWYgKCFhbm5vdHNPYmopIHtcbiAgICAgICAgLy8gQWZ0ZXJcbiAgICAgICAgY29uc3QgbmV3QXJyID0gcGRmRG9jLmNvbnRleHQub2JqKFtdKSBhcyBQREZBcnJheTtcbiAgICAgICAgcGFnZS5ub2RlLnNldChQREZOYW1lLm9mKFwiQW5ub3RzXCIpLCBuZXdBcnIpO1xuICAgICAgICBhbm5vdHNPYmogPSBuZXdBcnI7XG4gICAgICB9XG4gICAgICBhbm5vdHNPYmoucHVzaChhbm5vdGF0aW9uUmVmKTtcbiAgICB9XG5cbiAgICAvLyDilIDilIAgU2F2ZSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgICB0cnkge1xuICAgICAgY29uc3QgbW9kaWZpZWRQZGZCeXRlcyA9IGF3YWl0IHBkZkRvYy5zYXZlKCk7XG4gICAgICBhd2FpdCB0aGlzLmFwcC52YXVsdC5tb2RpZnlCaW5hcnkoXG4gICAgICAgIGZpbGUsXG4gICAgICAgIG1vZGlmaWVkUGRmQnl0ZXMuYnVmZmVyIGFzIEFycmF5QnVmZmVyLFxuICAgICAgKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIFNhdmUgZmFpbHVyZXMgYXJlIGFsbW9zdCBhbHdheXMgT1MgZmlsZSBsb2Nrc1xuICAgICAgdGhyb3cgbmV3IExvY2tlZFBkZkVycm9yKGZpbGUubmFtZSk7XG4gICAgfVxuICB9XG5cbiAgLy8g4pSA4pSAIFByaXZhdGUgaGVscGVycyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICBwcml2YXRlIGFzeW5jIF9hc3NlcnROb3RFbmNyeXB0ZWQoXG4gICAgYnl0ZXM6IEFycmF5QnVmZmVyLFxuICAgIGZpbGVOYW1lOiBzdHJpbmcsXG4gICk6IFByb21pc2U8dm9pZD4ge1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCBQREZEb2N1bWVudC5sb2FkKGJ5dGVzLCB7XG4gICAgICAgIHVwZGF0ZU1ldGFkYXRhOiBmYWxzZSxcbiAgICAgICAgaWdub3JlRW5jcnlwdGlvbjogZmFsc2UsXG4gICAgICB9KTtcbiAgICB9IGNhdGNoIChlOiBhbnkpIHtcbiAgICAgIGlmIChcbiAgICAgICAgZT8ubmFtZSA9PT0gXCJFbmNyeXB0ZWRQREZFcnJvclwiIHx8XG4gICAgICAgIGU/Lm1lc3NhZ2U/LnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoXCJlbmNyeXB0XCIpXG4gICAgICApIHtcbiAgICAgICAgdGhyb3cgbmV3IEVuY3J5cHRlZFBkZkVycm9yKGZpbGVOYW1lKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBwcml2YXRlIF9yZXNvbHZlQW5ub3RzQXJyYXkoXG4gICAgcGRmRG9jOiBQREZEb2N1bWVudCxcbiAgICBwYWdlOiBSZXR1cm5UeXBlPFBERkRvY3VtZW50W1wiZ2V0UGFnZXNcIl0+W251bWJlcl0sXG4gICk6IFBERkFycmF5IHwgbnVsbCB7XG4gICAgY29uc3QgYW5ub3RzVmFsID0gcGFnZS5ub2RlLkFubm90cygpO1xuICAgIGlmICghYW5ub3RzVmFsKSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCByZXNvbHZlZCA9IHBkZkRvYy5jb250ZXh0Lmxvb2t1cChhbm5vdHNWYWwpO1xuICAgIGlmIChyZXNvbHZlZCBpbnN0YW5jZW9mIFBERkFycmF5KSByZXR1cm4gcmVzb2x2ZWQ7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cblxuICBwcml2YXRlIF9wYXJzZVNwYXRpYWxJZChpZDogc3RyaW5nKSB7XG4gICAgY29uc3QgcGFydHMgPSBpZC5zcGxpdChcIjpcIik7XG4gICAgY29uc3QgcGFnZU51bSA9IHBhcnNlSW50KHBhcnRzWzFdID8/IFwiMVwiLCAxMCk7XG4gICAgY29uc3QgcmVjdFBhcnRzID0gKHBhcnRzWzJdID8/IFwiMCwwLDAsMFwiKS5zcGxpdChcIixcIikubWFwKE51bWJlcik7XG4gICAgcmV0dXJuIHtcbiAgICAgIHBhZ2U6IGlzTmFOKHBhZ2VOdW0pID8gMSA6IHBhZ2VOdW0sXG4gICAgICByZWN0OiB7XG4gICAgICAgIHBMZWZ0OiByZWN0UGFydHNbMF0gPz8gMCxcbiAgICAgICAgcFRvcDogcmVjdFBhcnRzWzFdID8/IDAsXG4gICAgICAgIHBXaWR0aDogcmVjdFBhcnRzWzJdID8/IDAsXG4gICAgICAgIHBIZWlnaHQ6IHJlY3RQYXJ0c1szXSA/PyAwLFxuICAgICAgfSxcbiAgICB9O1xuICB9XG5cbiAgcHJpdmF0ZSBfcGRmRGF0ZVN0cmluZygpOiBzdHJpbmcge1xuICAgIGNvbnN0IG5vdyA9IG5ldyBEYXRlKCk7XG4gICAgY29uc3QgcGFkID0gKG46IG51bWJlciwgbCA9IDIpID0+IG4udG9TdHJpbmcoKS5wYWRTdGFydChsLCBcIjBcIik7XG4gICAgY29uc3Qgb2Zmc2V0TWluID0gLW5vdy5nZXRUaW1lem9uZU9mZnNldCgpO1xuICAgIGNvbnN0IHNpZ24gPSBvZmZzZXRNaW4gPj0gMCA/IFwiK1wiIDogXCItXCI7XG4gICAgY29uc3QgYWJzT2ZmID0gTWF0aC5hYnMob2Zmc2V0TWluKTtcbiAgICByZXR1cm4gKFxuICAgICAgYEQ6JHtub3cuZ2V0RnVsbFllYXIoKX0ke3BhZChub3cuZ2V0TW9udGgoKSArIDEpfSR7cGFkKG5vdy5nZXREYXRlKCkpfWAgK1xuICAgICAgYCR7cGFkKG5vdy5nZXRIb3VycygpKX0ke3BhZChub3cuZ2V0TWludXRlcygpKX0ke3BhZChub3cuZ2V0U2Vjb25kcygpKX1gICtcbiAgICAgIGAke3NpZ259JHtwYWQoTWF0aC5mbG9vcihhYnNPZmYgLyA2MCkpfScke3BhZChhYnNPZmYgJSA2MCl9J2BcbiAgICApO1xuICB9XG59XG4vLyBiaXNod2FhXG4iXX0=
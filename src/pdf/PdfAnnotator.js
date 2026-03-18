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
                if (e instanceof Error &&
                    (e.name === "EncryptedPDFError" || e.message.includes("encrypted"))) {
                    throw new EncryptedPdfError(file.name);
                }
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
                                catch (_a) {
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
                            catch (_b) {
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
                    const newArr = pdfDoc.context.obj([]);
                    page.node.set(PDFName.of("Annots"), newArr);
                    annotsObj = newArr instanceof PDFArray ? newArr : null;
                }
                annotsObj === null || annotsObj === void 0 ? void 0 : annotsObj.push(annotationRef);
            }
            // ── Save ─────────────────────────────────────────────────────────────
            try {
                const modifiedPdfBytes = yield pdfDoc.save();
                yield this.app.vault.modifyBinary(file, modifiedPdfBytes.buffer);
            }
            catch (_c) {
                // Save failures are almost always OS file locks
                throw new LockedPdfError(file.name);
            }
        });
    }
    // ── Private helpers ───────────────────────────────────────────────────────
    _assertNotEncrypted(bytes, fileName) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                yield PDFDocument.load(bytes, {
                    updateMetadata: false,
                    ignoreEncryption: false,
                });
            }
            catch (e) {
                if (e instanceof Error &&
                    (e.name === "EncryptedPDFError" ||
                        e.message.toLowerCase().includes("encrypt"))) {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiUGRmQW5ub3RhdG9yLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiUGRmQW5ub3RhdG9yLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFDQSxPQUFPLEVBQ0wsV0FBVyxFQUNYLFNBQVMsRUFDVCxPQUFPLEVBQ1AsT0FBTyxFQUNQLFFBQVEsRUFDUixNQUFNLEdBRVAsTUFBTSxTQUFTLENBQUM7QUFxQmpCLE1BQU0sT0FBTyxpQkFBa0IsU0FBUSxLQUFLO0lBQzFDLFlBQVksUUFBZ0I7UUFDMUIsS0FBSyxDQUFDLElBQUksUUFBUSxrREFBa0QsQ0FBQyxDQUFDO1FBQ3RFLElBQUksQ0FBQyxJQUFJLEdBQUcsbUJBQW1CLENBQUM7SUFDbEMsQ0FBQztDQUNGO0FBRUQsTUFBTSxPQUFPLGNBQWUsU0FBUSxLQUFLO0lBQ3ZDLFlBQVksUUFBZ0I7UUFDMUIsS0FBSyxDQUFDLElBQUksUUFBUSxxQ0FBcUMsQ0FBQyxDQUFDO1FBQ3pELElBQUksQ0FBQyxJQUFJLEdBQUcsZ0JBQWdCLENBQUM7SUFDL0IsQ0FBQztDQUNGO0FBRUQsTUFBTSxPQUFPLFlBQVk7SUFHdkIsWUFBWSxHQUFRO1FBQ2xCLElBQUksQ0FBQyxHQUFHLEdBQUcsR0FBRyxDQUFDO0lBQ2pCLENBQUM7SUFFRCw2RUFBNkU7SUFDdkUsc0JBQXNCLENBQUMsSUFBVzs7WUFDdEMsTUFBTSxPQUFPLEdBQTBCLEVBQUUsQ0FBQztZQUMxQyxJQUFJLENBQUM7Z0JBQ0gsTUFBTSxLQUFLLEdBQUcsTUFBTSxJQUFJLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxVQUFVLENBQUMsSUFBSSxDQUFDLENBQUM7Z0JBRXBELDREQUE0RDtnQkFDNUQsc0RBQXNEO2dCQUN0RCxNQUFNLElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxLQUFLLEVBQUUsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO2dCQUVqRCxNQUFNLE1BQU0sR0FBRyxNQUFNLFdBQVcsQ0FBQyxJQUFJLENBQUMsS0FBSyxFQUFFO29CQUMzQyxj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QUFHLEVBQUUsQ0FBQyxHQUFHLENBQzlELENBQUM7SUFDSixDQUFDO0NBQ0Y7QUFDRCxVQUFVIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgQXBwLCBURmlsZSB9IGZyb20gXCJvYnNpZGlhblwiO1xuaW1wb3J0IHtcbiAgUERGRG9jdW1lbnQsXG4gIFBERlN0cmluZyxcbiAgUERGTmFtZSxcbiAgUERGRGljdCxcbiAgUERGQXJyYXksXG4gIFBERlJlZixcbiAgUERGTnVtYmVyLFxufSBmcm9tIFwicGRmLWxpYlwiO1xuaW1wb3J0IHsgUmVjdE92ZXJsYXkgfSBmcm9tIFwiLi4vaGlnaGxpZ2h0L1NlbGVjdGlvbkV4dHJhY3RvclwiO1xuXG5leHBvcnQgaW50ZXJmYWNlIFBkZkhpZ2hsaWdodFBheWxvYWQge1xuICBwYWdlTnVtYmVyOiBudW1iZXI7XG4gIHJlY3RzOiBSZWN0T3ZlcmxheVtdO1xuICBjb2xvclJnYjogW251bWJlciwgbnVtYmVyLCBudW1iZXJdO1xuICBvcGFjaXR5OiBudW1iZXI7XG4gIGF1dGhvcjogc3RyaW5nO1xuICBpZDogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFNhdmVkQW5ub3RhdGlvbkluZm8ge1xuICBpZDogc3RyaW5nIHwgbnVsbDtcbiAgcGFnZU51bWJlcjogbnVtYmVyO1xuICBwTGVmdDogbnVtYmVyO1xuICBwVG9wOiBudW1iZXI7XG4gIHBXaWR0aDogbnVtYmVyO1xuICBwSGVpZ2h0OiBudW1iZXI7XG59XG5cbmV4cG9ydCBjbGFzcyBFbmNyeXB0ZWRQZGZFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IoZmlsZU5hbWU6IHN0cmluZykge1xuICAgIHN1cGVyKGBcIiR7ZmlsZU5hbWV9XCIgaXMgcGFzc3dvcmQtcHJvdGVjdGVkIGFuZCBjYW5ub3QgYmUgYW5ub3RhdGVkLmApO1xuICAgIHRoaXMubmFtZSA9IFwiRW5jcnlwdGVkUGRmRXJyb3JcIjtcbiAgfVxufVxuXG5leHBvcnQgY2xhc3MgTG9ja2VkUGRmRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKGZpbGVOYW1lOiBzdHJpbmcpIHtcbiAgICBzdXBlcihgXCIke2ZpbGVOYW1lfVwiIGlzIGxvY2tlZCBieSBhbm90aGVyIGFwcGxpY2F0aW9uLmApO1xuICAgIHRoaXMubmFtZSA9IFwiTG9ja2VkUGRmRXJyb3JcIjtcbiAgfVxufVxuXG5leHBvcnQgY2xhc3MgUGRmQW5ub3RhdG9yIHtcbiAgYXBwOiBBcHA7XG5cbiAgY29uc3RydWN0b3IoYXBwOiBBcHApIHtcbiAgICB0aGlzLmFwcCA9IGFwcDtcbiAgfVxuXG4gIC8vIOKUgOKUgCBSZWFkIGFsbCBleGlzdGluZyBIaWdobGlnaHQgYW5ub3RhdGlvbnMgZnJvbSB0aGUgUERGIGJpbmFyeSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgYXN5bmMgcmVhZEFubm90YXRpb25zRnJvbVBkZihmaWxlOiBURmlsZSk6IFByb21pc2U8U2F2ZWRBbm5vdGF0aW9uSW5mb1tdPiB7XG4gICAgY29uc3QgcmVzdWx0czogU2F2ZWRBbm5vdGF0aW9uSW5mb1tdID0gW107XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGJ5dGVzID0gYXdhaXQgdGhpcy5hcHAudmF1bHQucmVhZEJpbmFyeShmaWxlKTtcblxuICAgICAgLy8gQ2hlY2sgZm9yIGVuY3J5cHRpb24gQkVGT1JFIGxvYWRpbmcgd2l0aCBpZ25vcmVFbmNyeXB0aW9uXG4gICAgICAvLyBzbyB3ZSBjYW4gc3VyZmFjZSBhIG1lYW5pbmdmdWwgZXJyb3IgdG8gdGhlIGNhbGxlci5cbiAgICAgIGF3YWl0IHRoaXMuX2Fzc2VydE5vdEVuY3J5cHRlZChieXRlcywgZmlsZS5uYW1lKTtcblxuICAgICAgY29uc3QgcGRmRG9jID0gYXdhaXQgUERGRG9jdW1lbnQubG9hZChieXRlcywge1xuICAgICAgICB1cGRhdGVNZXRhZGF0YTogZmFsc2UsXG4gICAgICAgIGlnbm9yZUVuY3J5cHRpb246IGZhbHNlLFxuICAgICAgfSk7XG5cbiAgICAgIGNvbnN0IHBhZ2VzID0gcGRmRG9jLmdldFBhZ2VzKCk7XG4gICAgICBmb3IgKGxldCBwYWdlSWR4ID0gMDsgcGFnZUlkeCA8IHBhZ2VzLmxlbmd0aDsgcGFnZUlkeCsrKSB7XG4gICAgICAgIGNvbnN0IHBhZ2UgPSBwYWdlc1twYWdlSWR4XTtcbiAgICAgICAgaWYgKCFwYWdlKSBjb250aW51ZTtcblxuICAgICAgICBjb25zdCB7IHdpZHRoLCBoZWlnaHQgfSA9IHBhZ2UuZ2V0U2l6ZSgpO1xuICAgICAgICBjb25zdCBhbm5vdHNPYmogPSB0aGlzLl9yZXNvbHZlQW5ub3RzQXJyYXkocGRmRG9jLCBwYWdlKTtcbiAgICAgICAgaWYgKCFhbm5vdHNPYmopIGNvbnRpbnVlO1xuXG4gICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYW5ub3RzT2JqLnNpemUoKTsgaSsrKSB7XG4gICAgICAgICAgY29uc3QgYW5ub3RSZWYgPSBhbm5vdHNPYmouZ2V0KGkpO1xuICAgICAgICAgIGNvbnN0IGFubm90ID0gcGRmRG9jLmNvbnRleHQubG9va3VwTWF5YmUoYW5ub3RSZWYsIFBERkRpY3QpO1xuICAgICAgICAgIGlmICghYW5ub3QpIGNvbnRpbnVlO1xuXG4gICAgICAgICAgY29uc3Qgc3VidHlwZSA9IGFubm90LmdldChQREZOYW1lLm9mKFwiU3VidHlwZVwiKSk7XG4gICAgICAgICAgaWYgKCFzdWJ0eXBlIHx8IHN1YnR5cGUudG9TdHJpbmcoKSAhPT0gXCIvSGlnaGxpZ2h0XCIpIGNvbnRpbnVlO1xuXG4gICAgICAgICAgbGV0IGlkOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICAgICAgICBjb25zdCBubU9iaiA9IGFubm90LmdldChQREZOYW1lLm9mKFwiTk1cIikpO1xuICAgICAgICAgIGlmIChubU9iaiBpbnN0YW5jZW9mIFBERlN0cmluZykge1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgaWQgPSBubU9iai5kZWNvZGVUZXh0KCk7XG4gICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgaWQgPSBubU9iai5hc1N0cmluZygpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cblxuICAgICAgICAgIGNvbnN0IHJlY3RBcnJheSA9IGFubm90LmdldChQREZOYW1lLm9mKFwiUmVjdFwiKSk7XG4gICAgICAgICAgaWYgKCEocmVjdEFycmF5IGluc3RhbmNlb2YgUERGQXJyYXkpIHx8IHJlY3RBcnJheS5zaXplKCkgIT09IDQpXG4gICAgICAgICAgICBjb250aW51ZTtcblxuICAgICAgICAgIGNvbnN0IG1pblggPSAocmVjdEFycmF5LmdldCgwKSBhcyBQREZOdW1iZXIpLmFzTnVtYmVyKCk7XG4gICAgICAgICAgY29uc3QgbWluWSA9IChyZWN0QXJyYXkuZ2V0KDEpIGFzIFBERk51bWJlcikuYXNOdW1iZXIoKTtcbiAgICAgICAgICBjb25zdCBtYXhYID0gKHJlY3RBcnJheS5nZXQoMikgYXMgUERGTnVtYmVyKS5hc051bWJlcigpO1xuICAgICAgICAgIGNvbnN0IG1heFkgPSAocmVjdEFycmF5LmdldCgzKSBhcyBQREZOdW1iZXIpLmFzTnVtYmVyKCk7XG5cbiAgICAgICAgICByZXN1bHRzLnB1c2goe1xuICAgICAgICAgICAgaWQsXG4gICAgICAgICAgICBwYWdlTnVtYmVyOiBwYWdlSWR4ICsgMSxcbiAgICAgICAgICAgIHBMZWZ0OiBtaW5YIC8gd2lkdGgsXG4gICAgICAgICAgICBwVG9wOiAxIC0gbWF4WSAvIGhlaWdodCxcbiAgICAgICAgICAgIHBXaWR0aDogKG1heFggLSBtaW5YKSAvIHdpZHRoLFxuICAgICAgICAgICAgcEhlaWdodDogKG1heFkgLSBtaW5ZKSAvIGhlaWdodCxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIC8vIFJlLXRocm93IG91ciB0eXBlZCBlcnJvcnM7IHN3YWxsb3cgZXZlcnl0aGluZyBlbHNlXG4gICAgICBpZiAoZSBpbnN0YW5jZW9mIEVuY3J5cHRlZFBkZkVycm9yKSB0aHJvdyBlO1xuICAgICAgY29uc29sZS5lcnJvcihcIltBbm5vdGF0ZVBERl0gcmVhZEFubm90YXRpb25zRnJvbVBkZiBmYWlsZWQ6XCIsIGUpO1xuICAgIH1cbiAgICByZXR1cm4gcmVzdWx0cztcbiAgfVxuXG4gIC8vIOKUgOKUgCBXcml0ZSBhZGRpdGlvbnMgKyBkZWxldGlvbnMgdG8gdGhlIFBERiBpbiBvbmUgYXRvbWljIHBhc3Mg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIGFzeW5jIGFwcGx5QmF0Y2hVcGRhdGVzVG9QZGYoXG4gICAgZmlsZTogVEZpbGUsXG4gICAgcGF5bG9hZHM6IFBkZkhpZ2hsaWdodFBheWxvYWRbXSxcbiAgICBkZWxldGlvbklkczogc3RyaW5nW10sXG4gICk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmIChwYXlsb2Fkcy5sZW5ndGggPT09IDAgJiYgZGVsZXRpb25JZHMubGVuZ3RoID09PSAwKSByZXR1cm47XG5cbiAgICBjb25zdCBmaWxlQ29udGVudCA9IGF3YWl0IHRoaXMuYXBwLnZhdWx0LnJlYWRCaW5hcnkoZmlsZSk7XG5cbiAgICAvLyDilIDilIAgRW5jcnlwdGlvbiBjaGVjayDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgICAvLyBNdXN0IGhhcHBlbiBiZWZvcmUgd2UgdHJ5IHRvIGxvYWQgKyBzYXZlLCBvdGhlcndpc2UgcGRmLWxpYiB0aHJvd3NcbiAgICAvLyBhIGdlbmVyaWMgRW5jcnlwdGVkUERGRXJyb3IgdGhhdCBsb29rcyBpZGVudGljYWwgdG8gYSBwYXJzZSBmYWlsdXJlLlxuICAgIGF3YWl0IHRoaXMuX2Fzc2VydE5vdEVuY3J5cHRlZChmaWxlQ29udGVudCwgZmlsZS5uYW1lKTtcblxuICAgIGxldCBwZGZEb2M6IFBERkRvY3VtZW50O1xuICAgIHRyeSB7XG4gICAgICBwZGZEb2MgPSBhd2FpdCBQREZEb2N1bWVudC5sb2FkKGZpbGVDb250ZW50LCB7XG4gICAgICAgIHVwZGF0ZU1ldGFkYXRhOiBmYWxzZSxcbiAgICAgICAgaWdub3JlRW5jcnlwdGlvbjogZmFsc2UsXG4gICAgICB9KTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBpZiAoXG4gICAgICAgIGUgaW5zdGFuY2VvZiBFcnJvciAmJlxuICAgICAgICAoZS5uYW1lID09PSBcIkVuY3J5cHRlZFBERkVycm9yXCIgfHwgZS5tZXNzYWdlLmluY2x1ZGVzKFwiZW5jcnlwdGVkXCIpKVxuICAgICAgKSB7XG4gICAgICAgIHRocm93IG5ldyBFbmNyeXB0ZWRQZGZFcnJvcihmaWxlLm5hbWUpO1xuICAgICAgfVxuICAgICAgdGhyb3cgbmV3IExvY2tlZFBkZkVycm9yKGZpbGUubmFtZSk7XG4gICAgfVxuXG4gICAgY29uc3QgcGFnZXMgPSBwZGZEb2MuZ2V0UGFnZXMoKTtcblxuICAgIC8vIOKUgOKUgCBEZWxldGlvbnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gICAgaWYgKGRlbGV0aW9uSWRzLmxlbmd0aCA+IDApIHtcbiAgICAgIGNvbnN0IGV4YWN0SWRzID0gbmV3IFNldChcbiAgICAgICAgZGVsZXRpb25JZHMuZmlsdGVyKChpZCkgPT4gIWlkLnN0YXJ0c1dpdGgoXCJTUEFUSUFMOlwiKSksXG4gICAgICApO1xuICAgICAgY29uc3Qgc3BhdGlhbFRhcmdldHMgPSBkZWxldGlvbklkc1xuICAgICAgICAuZmlsdGVyKChpZCkgPT4gaWQuc3RhcnRzV2l0aChcIlNQQVRJQUw6XCIpKVxuICAgICAgICAubWFwKChpZCkgPT4gdGhpcy5fcGFyc2VTcGF0aWFsSWQoaWQpKTtcblxuICAgICAgZm9yIChsZXQgcGFnZUlkeCA9IDA7IHBhZ2VJZHggPCBwYWdlcy5sZW5ndGg7IHBhZ2VJZHgrKykge1xuICAgICAgICBjb25zdCBwYWdlID0gcGFnZXNbcGFnZUlkeF07XG4gICAgICAgIGlmICghcGFnZSkgY29udGludWU7XG5cbiAgICAgICAgY29uc3QgeyB3aWR0aCwgaGVpZ2h0IH0gPSBwYWdlLmdldFNpemUoKTtcbiAgICAgICAgY29uc3QgYW5ub3RzT2JqID0gdGhpcy5fcmVzb2x2ZUFubm90c0FycmF5KHBkZkRvYywgcGFnZSk7XG4gICAgICAgIGlmICghYW5ub3RzT2JqKSBjb250aW51ZTtcblxuICAgICAgICBjb25zdCB0b0RlbGV0ZTogbnVtYmVyW10gPSBbXTtcblxuICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IGFubm90c09iai5zaXplKCk7IGkrKykge1xuICAgICAgICAgIGNvbnN0IGFubm90UmVmID0gYW5ub3RzT2JqLmdldChpKTtcbiAgICAgICAgICBjb25zdCBhbm5vdCA9IHBkZkRvYy5jb250ZXh0Lmxvb2t1cE1heWJlKGFubm90UmVmLCBQREZEaWN0KTtcbiAgICAgICAgICBpZiAoIWFubm90KSBjb250aW51ZTtcblxuICAgICAgICAgIC8vIEV4YWN0IE5NIG1hdGNoXG4gICAgICAgICAgaWYgKGV4YWN0SWRzLnNpemUgPiAwKSB7XG4gICAgICAgICAgICBjb25zdCBubU9iaiA9IGFubm90LmdldChQREZOYW1lLm9mKFwiTk1cIikpO1xuICAgICAgICAgICAgaWYgKG5tT2JqIGluc3RhbmNlb2YgUERGU3RyaW5nKSB7XG4gICAgICAgICAgICAgIGxldCBubVZhbHVlOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBubVZhbHVlID0gbm1PYmouZGVjb2RlVGV4dCgpO1xuICAgICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgICBubVZhbHVlID0gbm1PYmouYXNTdHJpbmcoKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICBpZiAobm1WYWx1ZSAhPT0gbnVsbCAmJiBleGFjdElkcy5oYXMobm1WYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICB0b0RlbGV0ZS5wdXNoKGkpO1xuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgLy8gU3BhdGlhbCBvdmVybGFwIGZhbGxiYWNrXG4gICAgICAgICAgaWYgKHNwYXRpYWxUYXJnZXRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIGNvbnN0IHN1YnR5cGUgPSBhbm5vdC5nZXQoUERGTmFtZS5vZihcIlN1YnR5cGVcIikpO1xuICAgICAgICAgICAgaWYgKCFzdWJ0eXBlIHx8IHN1YnR5cGUudG9TdHJpbmcoKSAhPT0gXCIvSGlnaGxpZ2h0XCIpIGNvbnRpbnVlO1xuXG4gICAgICAgICAgICBjb25zdCByZWN0QXJyYXkgPSBhbm5vdC5nZXQoUERGTmFtZS5vZihcIlJlY3RcIikpO1xuICAgICAgICAgICAgaWYgKCEocmVjdEFycmF5IGluc3RhbmNlb2YgUERGQXJyYXkpIHx8IHJlY3RBcnJheS5zaXplKCkgIT09IDQpXG4gICAgICAgICAgICAgIGNvbnRpbnVlO1xuXG4gICAgICAgICAgICBjb25zdCBhTWluWCA9IChyZWN0QXJyYXkuZ2V0KDApIGFzIFBERk51bWJlcikuYXNOdW1iZXIoKTtcbiAgICAgICAgICAgIGNvbnN0IGFNaW5ZID0gKHJlY3RBcnJheS5nZXQoMSkgYXMgUERGTnVtYmVyKS5hc051bWJlcigpO1xuICAgICAgICAgICAgY29uc3QgYU1heFggPSAocmVjdEFycmF5LmdldCgyKSBhcyBQREZOdW1iZXIpLmFzTnVtYmVyKCk7XG4gICAgICAgICAgICBjb25zdCBhTWF4WSA9IChyZWN0QXJyYXkuZ2V0KDMpIGFzIFBERk51bWJlcikuYXNOdW1iZXIoKTtcblxuICAgICAgICAgICAgY29uc3QgcGFnZU51bSA9IHBhZ2VJZHggKyAxO1xuICAgICAgICAgICAgZm9yIChjb25zdCBzIG9mIHNwYXRpYWxUYXJnZXRzKSB7XG4gICAgICAgICAgICAgIGlmIChzLnBhZ2UgIT09IHBhZ2VOdW0pIGNvbnRpbnVlO1xuICAgICAgICAgICAgICBjb25zdCBUT0xFUkFOQ0UgPSAyO1xuICAgICAgICAgICAgICBjb25zdCBzTWluWCA9IHMucmVjdC5wTGVmdCAqIHdpZHRoO1xuICAgICAgICAgICAgICBjb25zdCBzTWF4WCA9IChzLnJlY3QucExlZnQgKyBzLnJlY3QucFdpZHRoKSAqIHdpZHRoO1xuICAgICAgICAgICAgICBjb25zdCBzTWluWSA9IGhlaWdodCAtIChzLnJlY3QucFRvcCArIHMucmVjdC5wSGVpZ2h0KSAqIGhlaWdodDtcbiAgICAgICAgICAgICAgY29uc3Qgc01heFkgPSBoZWlnaHQgLSBzLnJlY3QucFRvcCAqIGhlaWdodDtcblxuICAgICAgICAgICAgICBpZiAoXG4gICAgICAgICAgICAgICAgTWF0aC5tYXgoYU1pblgsIHNNaW5YIC0gVE9MRVJBTkNFKSA8XG4gICAgICAgICAgICAgICAgICBNYXRoLm1pbihhTWF4WCwgc01heFggKyBUT0xFUkFOQ0UpICYmXG4gICAgICAgICAgICAgICAgTWF0aC5tYXgoYU1pblksIHNNaW5ZIC0gVE9MRVJBTkNFKSA8XG4gICAgICAgICAgICAgICAgICBNYXRoLm1pbihhTWF4WSwgc01heFkgKyBUT0xFUkFOQ0UpXG4gICAgICAgICAgICAgICkge1xuICAgICAgICAgICAgICAgIHRvRGVsZXRlLnB1c2goaSk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBmb3IgKGxldCBrID0gdG9EZWxldGUubGVuZ3RoIC0gMTsgayA+PSAwOyBrLS0pIHtcbiAgICAgICAgICBjb25zdCBpZHggPSB0b0RlbGV0ZVtrXSE7XG4gICAgICAgICAgY29uc3QgYW5ub3RSZWYgPSBhbm5vdHNPYmouZ2V0KGlkeCk7XG4gICAgICAgICAgYW5ub3RzT2JqLnJlbW92ZShpZHgpO1xuICAgICAgICAgIGlmIChhbm5vdFJlZiBpbnN0YW5jZW9mIFBERlJlZikge1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgcGRmRG9jLmNvbnRleHQuZGVsZXRlKGFubm90UmVmKTtcbiAgICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgICAvKiBhbHJlYWR5IGdvbmUgKi9cbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyDilIDilIAgQWRkaXRpb25zIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAgIGZvciAoY29uc3QgcGF5bG9hZCBvZiBwYXlsb2Fkcykge1xuICAgICAgY29uc3QgcGFnZSA9IHBhZ2VzW3BheWxvYWQucGFnZU51bWJlciAtIDFdO1xuICAgICAgaWYgKCFwYWdlKSBjb250aW51ZTtcblxuICAgICAgY29uc3QgeyB3aWR0aCwgaGVpZ2h0IH0gPSBwYWdlLmdldFNpemUoKTtcbiAgICAgIGNvbnN0IHF1YWRQb2ludHNMaXN0OiBudW1iZXJbXSA9IFtdO1xuICAgICAgbGV0IG1pblggPSBJbmZpbml0eSxcbiAgICAgICAgbWluWSA9IEluZmluaXR5LFxuICAgICAgICBtYXhYID0gLUluZmluaXR5LFxuICAgICAgICBtYXhZID0gLUluZmluaXR5O1xuXG4gICAgICBmb3IgKGNvbnN0IHIgb2YgcGF5bG9hZC5yZWN0cykge1xuICAgICAgICBjb25zdCByTWluWCA9IHIucExlZnQgKiB3aWR0aDtcbiAgICAgICAgY29uc3Qgck1heFggPSAoci5wTGVmdCArIHIucFdpZHRoKSAqIHdpZHRoO1xuICAgICAgICBjb25zdCByTWluWSA9IGhlaWdodCAtIChyLnBUb3AgKyByLnBIZWlnaHQpICogaGVpZ2h0O1xuICAgICAgICBjb25zdCByTWF4WSA9IGhlaWdodCAtIHIucFRvcCAqIGhlaWdodDtcblxuICAgICAgICBxdWFkUG9pbnRzTGlzdC5wdXNoKFxuICAgICAgICAgIHJNaW5YLFxuICAgICAgICAgIHJNYXhZLFxuICAgICAgICAgIHJNYXhYLFxuICAgICAgICAgIHJNYXhZLFxuICAgICAgICAgIHJNaW5YLFxuICAgICAgICAgIHJNaW5ZLFxuICAgICAgICAgIHJNYXhYLFxuICAgICAgICAgIHJNaW5ZLFxuICAgICAgICApO1xuICAgICAgICBtaW5YID0gTWF0aC5taW4obWluWCwgck1pblgpO1xuICAgICAgICBtYXhYID0gTWF0aC5tYXgobWF4WCwgck1heFgpO1xuICAgICAgICBtaW5ZID0gTWF0aC5taW4obWluWSwgck1pblkpO1xuICAgICAgICBtYXhZID0gTWF0aC5tYXgobWF4WSwgck1heFkpO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBoaWdobGlnaHRBbm5vdGF0aW9uID0gcGRmRG9jLmNvbnRleHQub2JqKHtcbiAgICAgICAgVHlwZTogXCJBbm5vdFwiLFxuICAgICAgICBTdWJ0eXBlOiBcIkhpZ2hsaWdodFwiLFxuICAgICAgICBOTTogUERGU3RyaW5nLm9mKHBheWxvYWQuaWQpLFxuICAgICAgICBSZWN0OiBbbWluWCwgbWluWSwgbWF4WCwgbWF4WV0sXG4gICAgICAgIFF1YWRQb2ludHM6IHF1YWRQb2ludHNMaXN0LFxuICAgICAgICBDOiBwYXlsb2FkLmNvbG9yUmdiLFxuICAgICAgICBDQTogcGF5bG9hZC5vcGFjaXR5LFxuICAgICAgICBUOiBQREZTdHJpbmcub2YocGF5bG9hZC5hdXRob3IpLFxuICAgICAgICBDcmVhdGlvbkRhdGU6IFBERlN0cmluZy5vZih0aGlzLl9wZGZEYXRlU3RyaW5nKCkpLFxuICAgICAgICBNOiBQREZTdHJpbmcub2YodGhpcy5fcGRmRGF0ZVN0cmluZygpKSxcbiAgICAgICAgRjogNCxcbiAgICAgIH0pO1xuXG4gICAgICBjb25zdCBhbm5vdGF0aW9uUmVmID0gcGRmRG9jLmNvbnRleHQucmVnaXN0ZXIoaGlnaGxpZ2h0QW5ub3RhdGlvbik7XG4gICAgICBsZXQgYW5ub3RzT2JqID0gdGhpcy5fcmVzb2x2ZUFubm90c0FycmF5KHBkZkRvYywgcGFnZSk7XG4gICAgICBpZiAoIWFubm90c09iaikge1xuICAgICAgICBjb25zdCBuZXdBcnIgPSBwZGZEb2MuY29udGV4dC5vYmooW10pO1xuICAgICAgICBwYWdlLm5vZGUuc2V0KFBERk5hbWUub2YoXCJBbm5vdHNcIiksIG5ld0Fycik7XG4gICAgICAgIGFubm90c09iaiA9IG5ld0FyciBpbnN0YW5jZW9mIFBERkFycmF5ID8gbmV3QXJyIDogbnVsbDtcbiAgICAgIH1cbiAgICAgIGFubm90c09iaj8ucHVzaChhbm5vdGF0aW9uUmVmKTtcbiAgICB9XG5cbiAgICAvLyDilIDilIAgU2F2ZSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgICB0cnkge1xuICAgICAgY29uc3QgbW9kaWZpZWRQZGZCeXRlcyA9IGF3YWl0IHBkZkRvYy5zYXZlKCk7XG4gICAgICBhd2FpdCB0aGlzLmFwcC52YXVsdC5tb2RpZnlCaW5hcnkoXG4gICAgICAgIGZpbGUsXG4gICAgICAgIG1vZGlmaWVkUGRmQnl0ZXMuYnVmZmVyIGFzIEFycmF5QnVmZmVyLFxuICAgICAgKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIFNhdmUgZmFpbHVyZXMgYXJlIGFsbW9zdCBhbHdheXMgT1MgZmlsZSBsb2Nrc1xuICAgICAgdGhyb3cgbmV3IExvY2tlZFBkZkVycm9yKGZpbGUubmFtZSk7XG4gICAgfVxuICB9XG5cbiAgLy8g4pSA4pSAIFByaXZhdGUgaGVscGVycyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICBwcml2YXRlIGFzeW5jIF9hc3NlcnROb3RFbmNyeXB0ZWQoXG4gICAgYnl0ZXM6IEFycmF5QnVmZmVyLFxuICAgIGZpbGVOYW1lOiBzdHJpbmcsXG4gICk6IFByb21pc2U8dm9pZD4ge1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCBQREZEb2N1bWVudC5sb2FkKGJ5dGVzLCB7XG4gICAgICAgIHVwZGF0ZU1ldGFkYXRhOiBmYWxzZSxcbiAgICAgICAgaWdub3JlRW5jcnlwdGlvbjogZmFsc2UsXG4gICAgICB9KTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBpZiAoXG4gICAgICAgIGUgaW5zdGFuY2VvZiBFcnJvciAmJlxuICAgICAgICAoZS5uYW1lID09PSBcIkVuY3J5cHRlZFBERkVycm9yXCIgfHxcbiAgICAgICAgICBlLm1lc3NhZ2UudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhcImVuY3J5cHRcIikpXG4gICAgICApIHtcbiAgICAgICAgdGhyb3cgbmV3IEVuY3J5cHRlZFBkZkVycm9yKGZpbGVOYW1lKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBwcml2YXRlIF9yZXNvbHZlQW5ub3RzQXJyYXkoXG4gICAgcGRmRG9jOiBQREZEb2N1bWVudCxcbiAgICBwYWdlOiBSZXR1cm5UeXBlPFBERkRvY3VtZW50W1wiZ2V0UGFnZXNcIl0+W251bWJlcl0sXG4gICk6IFBERkFycmF5IHwgbnVsbCB7XG4gICAgY29uc3QgYW5ub3RzVmFsID0gcGFnZS5ub2RlLkFubm90cygpO1xuICAgIGlmICghYW5ub3RzVmFsKSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCByZXNvbHZlZCA9IHBkZkRvYy5jb250ZXh0Lmxvb2t1cChhbm5vdHNWYWwpO1xuICAgIGlmIChyZXNvbHZlZCBpbnN0YW5jZW9mIFBERkFycmF5KSByZXR1cm4gcmVzb2x2ZWQ7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cblxuICBwcml2YXRlIF9wYXJzZVNwYXRpYWxJZChpZDogc3RyaW5nKSB7XG4gICAgY29uc3QgcGFydHMgPSBpZC5zcGxpdChcIjpcIik7XG4gICAgY29uc3QgcGFnZU51bSA9IHBhcnNlSW50KHBhcnRzWzFdID8/IFwiMVwiLCAxMCk7XG4gICAgY29uc3QgcmVjdFBhcnRzID0gKHBhcnRzWzJdID8/IFwiMCwwLDAsMFwiKS5zcGxpdChcIixcIikubWFwKE51bWJlcik7XG4gICAgcmV0dXJuIHtcbiAgICAgIHBhZ2U6IGlzTmFOKHBhZ2VOdW0pID8gMSA6IHBhZ2VOdW0sXG4gICAgICByZWN0OiB7XG4gICAgICAgIHBMZWZ0OiByZWN0UGFydHNbMF0gPz8gMCxcbiAgICAgICAgcFRvcDogcmVjdFBhcnRzWzFdID8/IDAsXG4gICAgICAgIHBXaWR0aDogcmVjdFBhcnRzWzJdID8/IDAsXG4gICAgICAgIHBIZWlnaHQ6IHJlY3RQYXJ0c1szXSA/PyAwLFxuICAgICAgfSxcbiAgICB9O1xuICB9XG5cbiAgcHJpdmF0ZSBfcGRmRGF0ZVN0cmluZygpOiBzdHJpbmcge1xuICAgIGNvbnN0IG5vdyA9IG5ldyBEYXRlKCk7XG4gICAgY29uc3QgcGFkID0gKG46IG51bWJlciwgbCA9IDIpID0+IG4udG9TdHJpbmcoKS5wYWRTdGFydChsLCBcIjBcIik7XG4gICAgY29uc3Qgb2Zmc2V0TWluID0gLW5vdy5nZXRUaW1lem9uZU9mZnNldCgpO1xuICAgIGNvbnN0IHNpZ24gPSBvZmZzZXRNaW4gPj0gMCA/IFwiK1wiIDogXCItXCI7XG4gICAgY29uc3QgYWJzT2ZmID0gTWF0aC5hYnMob2Zmc2V0TWluKTtcbiAgICByZXR1cm4gKFxuICAgICAgYEQ6JHtub3cuZ2V0RnVsbFllYXIoKX0ke3BhZChub3cuZ2V0TW9udGgoKSArIDEpfSR7cGFkKG5vdy5nZXREYXRlKCkpfWAgK1xuICAgICAgYCR7cGFkKG5vdy5nZXRIb3VycygpKX0ke3BhZChub3cuZ2V0TWludXRlcygpKX0ke3BhZChub3cuZ2V0U2Vjb25kcygpKX1gICtcbiAgICAgIGAke3NpZ259JHtwYWQoTWF0aC5mbG9vcihhYnNPZmYgLyA2MCkpfScke3BhZChhYnNPZmYgJSA2MCl9J2BcbiAgICApO1xuICB9XG59XG4vLyBiaXNod2FhXG4iXX0=
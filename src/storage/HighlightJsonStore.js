import { __awaiter } from "tslib";
function parsePluginData(raw) {
    if (raw && typeof raw === "object" && "fileMap" in raw) {
        return raw;
    }
    return { fileMap: {} };
}
export class HighlightJsonStore {
    constructor(plugin) {
        this.plugin = plugin;
    }
    saveHighlight(pdfPath, highlight) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.saveHighlightsBatch(pdfPath, [highlight]);
        });
    }
    saveHighlightsBatch(pdfPath, highlights) {
        return __awaiter(this, void 0, void 0, function* () {
            const data = parsePluginData(yield this.plugin.loadData());
            if (!data.fileMap[pdfPath]) {
                data.fileMap[pdfPath] = { highlights: [] };
            }
            data.fileMap[pdfPath].highlights.push(...highlights);
            yield this.plugin.saveData(data);
        });
    }
    loadHighlights(pdfPath) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const data = parsePluginData(yield this.plugin.loadData());
            return (_b = (_a = data.fileMap[pdfPath]) === null || _a === void 0 ? void 0 : _a.highlights) !== null && _b !== void 0 ? _b : [];
        });
    }
    applyBatchUpdatesToJson(pdfPath, highlightsToAdd, idsToDelete) {
        return __awaiter(this, void 0, void 0, function* () {
            const data = parsePluginData(yield this.plugin.loadData());
            if (!data.fileMap[pdfPath]) {
                data.fileMap[pdfPath] = { highlights: [] };
            }
            if (idsToDelete.length > 0) {
                data.fileMap[pdfPath].highlights = data.fileMap[pdfPath].highlights.filter((h) => !idsToDelete.includes(h.id));
            }
            if (highlightsToAdd.length > 0) {
                data.fileMap[pdfPath].highlights.push(...highlightsToAdd);
            }
            yield this.plugin.saveData(data);
        });
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiSGlnaGxpZ2h0SnNvblN0b3JlLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiSGlnaGxpZ2h0SnNvblN0b3JlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUF5QkEsU0FBUyxlQUFlLENBQUMsR0FBWTtJQUNuQyxJQUFJLEdBQUcsSUFBSSxPQUFPLEdBQUcsS0FBSyxRQUFRLElBQUksU0FBUyxJQUFJLEdBQUcsRUFBRSxDQUFDO1FBQ3ZELE9BQU8sR0FBaUIsQ0FBQztJQUMzQixDQUFDO0lBQ0QsT0FBTyxFQUFFLE9BQU8sRUFBRSxFQUFFLEVBQUUsQ0FBQztBQUN6QixDQUFDO0FBRUQsTUFBTSxPQUFPLGtCQUFrQjtJQUc3QixZQUFZLE1BQW1DO1FBQzdDLElBQUksQ0FBQyxNQUFNLEdBQUcsTUFBTSxDQUFDO0lBQ3ZCLENBQUM7SUFFSyxhQUFhLENBQUMsT0FBZSxFQUFFLFNBQXlCOztZQUM1RCxNQUFNLElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxPQUFPLEVBQUUsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDO1FBQ3ZELENBQUM7S0FBQTtJQUVLLG1CQUFtQixDQUFDLE9BQWUsRUFBRSxVQUE0Qjs7WUFDckUsTUFBTSxJQUFJLEdBQUcsZUFBZSxDQUFDLE1BQU0sSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLEVBQUUsQ0FBQyxDQUFDO1lBRTNELElBQUksQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7Z0JBQzNCLElBQUksQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLEdBQUcsRUFBRSxVQUFVLEVBQUUsRUFBRSxFQUFFLENBQUM7WUFDN0MsQ0FBQztZQUNELElBQUksQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLENBQUMsVUFBVSxDQUFDLElBQUksQ0FBQyxHQUFHLFVBQVUsQ0FBQyxDQUFDO1lBRXJELE1BQU0sSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDbkMsQ0FBQztLQUFBO0lBRUssY0FBYyxDQUFDLE9BQWU7OztZQUNsQyxNQUFNLElBQUksR0FBRyxlQUFlLENBQUMsTUFBTSxJQUFJLENBQUMsTUFBTSxDQUFDLFFBQVEsRUFBRSxDQUFDLENBQUM7WUFDM0QsT0FBTyxNQUFBLE1BQUEsSUFBSSxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUMsMENBQUUsVUFBVSxtQ0FBSSxFQUFFLENBQUM7UUFDakQsQ0FBQztLQUFBO0lBRUssdUJBQXVCLENBQzNCLE9BQWUsRUFDZixlQUFpQyxFQUNqQyxXQUFxQjs7WUFFckIsTUFBTSxJQUFJLEdBQUcsZUFBZSxDQUFDLE1BQU0sSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLEVBQUUsQ0FBQyxDQUFDO1lBRTNELElBQUksQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7Z0JBQzNCLElBQUksQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLEdBQUcsRUFBRSxVQUFVLEVBQUUsRUFBRSxFQUFFLENBQUM7WUFDN0MsQ0FBQztZQUVELElBQUksV0FBVyxDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUUsQ0FBQztnQkFDM0IsSUFBSSxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUMsQ0FBQyxVQUFVLEdBQUcsSUFBSSxDQUFDLE9BQU8sQ0FDN0MsT0FBTyxDQUNSLENBQUMsVUFBVSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxXQUFXLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDO1lBQzFELENBQUM7WUFFRCxJQUFJLGVBQWUsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFLENBQUM7Z0JBQy9CLElBQUksQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLENBQUMsVUFBVSxDQUFDLElBQUksQ0FBQyxHQUFHLGVBQWUsQ0FBQyxDQUFDO1lBQzVELENBQUM7WUFFRCxNQUFNLElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQ25DLENBQUM7S0FBQTtDQUNGIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IFBkZkhpZ2hsaWdodGVyQmlzaHdhYVBsdWdpbiBmcm9tIFwiLi4vbWFpblwiO1xuaW1wb3J0IHsgUmVjdE92ZXJsYXkgfSBmcm9tIFwiLi4vaGlnaGxpZ2h0L1NlbGVjdGlvbkV4dHJhY3RvclwiO1xuXG5leHBvcnQgaW50ZXJmYWNlIEhpZ2hsaWdodE1vZGVsIHtcbiAgaWQ6IHN0cmluZztcbiAgcGFnZTogbnVtYmVyO1xuICByZWN0czogUmVjdE92ZXJsYXlbXTtcbiAgdGV4dDogc3RyaW5nO1xuICBjb2xvcjogc3RyaW5nO1xuICBvcGFjaXR5OiBudW1iZXI7XG4gIGF1dGhvcjogc3RyaW5nO1xuICB0aW1lc3RhbXA6IG51bWJlcjtcbn1cblxuaW50ZXJmYWNlIEhpZ2hsaWdodEZpbGVNYXAge1xuICBbcGRmRmlsZVBhdGg6IHN0cmluZ106IHtcbiAgICBoaWdobGlnaHRzOiBIaWdobGlnaHRNb2RlbFtdO1xuICB9O1xufVxuXG4vLyBUeXBlZCB3cmFwcGVyIGZvciB3aGF0IGxvYWREYXRhKCkgcmV0dXJucyBzbyB3ZSBuZXZlciB0b3VjaCBgYW55YFxuaW50ZXJmYWNlIFBsdWdpbkRhdGEge1xuICBmaWxlTWFwOiBIaWdobGlnaHRGaWxlTWFwO1xufVxuXG5mdW5jdGlvbiBwYXJzZVBsdWdpbkRhdGEocmF3OiB1bmtub3duKTogUGx1Z2luRGF0YSB7XG4gIGlmIChyYXcgJiYgdHlwZW9mIHJhdyA9PT0gXCJvYmplY3RcIiAmJiBcImZpbGVNYXBcIiBpbiByYXcpIHtcbiAgICByZXR1cm4gcmF3IGFzIFBsdWdpbkRhdGE7XG4gIH1cbiAgcmV0dXJuIHsgZmlsZU1hcDoge30gfTtcbn1cblxuZXhwb3J0IGNsYXNzIEhpZ2hsaWdodEpzb25TdG9yZSB7XG4gIHBsdWdpbjogUGRmSGlnaGxpZ2h0ZXJCaXNod2FhUGx1Z2luO1xuXG4gIGNvbnN0cnVjdG9yKHBsdWdpbjogUGRmSGlnaGxpZ2h0ZXJCaXNod2FhUGx1Z2luKSB7XG4gICAgdGhpcy5wbHVnaW4gPSBwbHVnaW47XG4gIH1cblxuICBhc3luYyBzYXZlSGlnaGxpZ2h0KHBkZlBhdGg6IHN0cmluZywgaGlnaGxpZ2h0OiBIaWdobGlnaHRNb2RlbCkge1xuICAgIGF3YWl0IHRoaXMuc2F2ZUhpZ2hsaWdodHNCYXRjaChwZGZQYXRoLCBbaGlnaGxpZ2h0XSk7XG4gIH1cblxuICBhc3luYyBzYXZlSGlnaGxpZ2h0c0JhdGNoKHBkZlBhdGg6IHN0cmluZywgaGlnaGxpZ2h0czogSGlnaGxpZ2h0TW9kZWxbXSkge1xuICAgIGNvbnN0IGRhdGEgPSBwYXJzZVBsdWdpbkRhdGEoYXdhaXQgdGhpcy5wbHVnaW4ubG9hZERhdGEoKSk7XG5cbiAgICBpZiAoIWRhdGEuZmlsZU1hcFtwZGZQYXRoXSkge1xuICAgICAgZGF0YS5maWxlTWFwW3BkZlBhdGhdID0geyBoaWdobGlnaHRzOiBbXSB9O1xuICAgIH1cbiAgICBkYXRhLmZpbGVNYXBbcGRmUGF0aF0uaGlnaGxpZ2h0cy5wdXNoKC4uLmhpZ2hsaWdodHMpO1xuXG4gICAgYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZURhdGEoZGF0YSk7XG4gIH1cblxuICBhc3luYyBsb2FkSGlnaGxpZ2h0cyhwZGZQYXRoOiBzdHJpbmcpOiBQcm9taXNlPEhpZ2hsaWdodE1vZGVsW10+IHtcbiAgICBjb25zdCBkYXRhID0gcGFyc2VQbHVnaW5EYXRhKGF3YWl0IHRoaXMucGx1Z2luLmxvYWREYXRhKCkpO1xuICAgIHJldHVybiBkYXRhLmZpbGVNYXBbcGRmUGF0aF0/LmhpZ2hsaWdodHMgPz8gW107XG4gIH1cblxuICBhc3luYyBhcHBseUJhdGNoVXBkYXRlc1RvSnNvbihcbiAgICBwZGZQYXRoOiBzdHJpbmcsXG4gICAgaGlnaGxpZ2h0c1RvQWRkOiBIaWdobGlnaHRNb2RlbFtdLFxuICAgIGlkc1RvRGVsZXRlOiBzdHJpbmdbXSxcbiAgKSB7XG4gICAgY29uc3QgZGF0YSA9IHBhcnNlUGx1Z2luRGF0YShhd2FpdCB0aGlzLnBsdWdpbi5sb2FkRGF0YSgpKTtcblxuICAgIGlmICghZGF0YS5maWxlTWFwW3BkZlBhdGhdKSB7XG4gICAgICBkYXRhLmZpbGVNYXBbcGRmUGF0aF0gPSB7IGhpZ2hsaWdodHM6IFtdIH07XG4gICAgfVxuXG4gICAgaWYgKGlkc1RvRGVsZXRlLmxlbmd0aCA+IDApIHtcbiAgICAgIGRhdGEuZmlsZU1hcFtwZGZQYXRoXS5oaWdobGlnaHRzID0gZGF0YS5maWxlTWFwW1xuICAgICAgICBwZGZQYXRoXG4gICAgICBdLmhpZ2hsaWdodHMuZmlsdGVyKChoKSA9PiAhaWRzVG9EZWxldGUuaW5jbHVkZXMoaC5pZCkpO1xuICAgIH1cblxuICAgIGlmIChoaWdobGlnaHRzVG9BZGQubGVuZ3RoID4gMCkge1xuICAgICAgZGF0YS5maWxlTWFwW3BkZlBhdGhdLmhpZ2hsaWdodHMucHVzaCguLi5oaWdobGlnaHRzVG9BZGQpO1xuICAgIH1cblxuICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVEYXRhKGRhdGEpO1xuICB9XG59XG4iXX0=
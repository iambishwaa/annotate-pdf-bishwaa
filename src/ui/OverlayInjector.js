import { __awaiter } from "tslib";
export class OverlayInjector {
    constructor(app, store, settings) {
        this.activePdfPath = null;
        this.observer = null;
        this.currentHighlights = [];
        this.app = app;
        this.store = store;
        this.settings = settings;
    }
    registerListeners() {
        // Listen to active leaf changes to detect when a PDF is opened
        this.app.workspace.on('active-leaf-change', (leaf) => __awaiter(this, void 0, void 0, function* () {
            if (!leaf)
                return;
            const view = leaf.view;
            const file = this.app.workspace.getActiveFile();
            if (view.getViewType() === 'pdf' && file && file.extension === 'pdf') {
                yield this.initOverlaySystem(file, view.containerEl);
            }
            else {
                this.cleanup();
            }
        }));
    }
    initOverlaySystem(file, container) {
        return __awaiter(this, void 0, void 0, function* () {
            this.activePdfPath = file.path;
            this.currentHighlights = yield this.store.loadHighlights(this.activePdfPath);
            this.cleanupObserver();
            // PDFs render asynchronously and dynamically as the user scrolls.
            // We must watch the DOM for new `.page` divs being attached by pdf.js
            this.observer = new MutationObserver((mutations) => {
                for (const mutation of mutations) {
                    if (mutation.type === 'childList') {
                        mutation.addedNodes.forEach((node) => {
                            if (node.nodeType === Node.ELEMENT_NODE) {
                                const el = node;
                                // Check if a new page container was added or a child inside a page was rendered
                                if (el.classList && el.classList.contains('page')) {
                                    this.renderHighlightsForPageNode(el);
                                }
                                else if (el.classList && el.classList.contains('textLayer')) {
                                    // Sometimes the page exists but the textLayer mounts later
                                    const parent = el.closest('.page');
                                    if (parent) {
                                        this.renderHighlightsForPageNode(parent);
                                    }
                                }
                            }
                        });
                    }
                }
            });
            // Search the current DOM in case they are already rendered before the mutation observer fires
            const existingPages = container.querySelectorAll('.page');
            existingPages.forEach(node => this.renderHighlightsForPageNode(node));
            this.observer.observe(container, {
                childList: true,
                subtree: true
            });
        });
    }
    renderHighlightsForPageNode(pageNode) {
        const pageNumStr = pageNode.getAttribute('data-page-number');
        if (!pageNumStr)
            return;
        const pageNum = parseInt(pageNumStr, 10);
        const highlightsForThisPage = this.currentHighlights.filter(h => h.page === pageNum);
        if (highlightsForThisPage.length === 0)
            return;
        // Ensure we only render once per highlight per node to avoid duplication if observers fire densely
        const overlayContainerId = `pdf-highlighter-layer-${pageNum}`;
        let overlayContainer = pageNode.querySelector(`#${overlayContainerId}`);
        if (!overlayContainer) {
            overlayContainer = document.createElement('div');
            overlayContainer.id = overlayContainerId;
            overlayContainer.className = 'pdf-highlighter-overlay-container';
            // Critical Setup: We want this div to sit absolute, covering the page, 
            // but UNDER the invisible textLayer (which usually has z-index 2), and OVER the canvas (z-index 1).
            overlayContainer.style.position = 'absolute';
            overlayContainer.style.top = '0';
            overlayContainer.style.left = '0';
            overlayContainer.style.width = '100%';
            overlayContainer.style.height = '100%';
            overlayContainer.style.zIndex = '1';
            overlayContainer.style.pointerEvents = 'none'; // Essential so it doesn't block text selection
            // Find the canvas to insert right after it
            const canvas = pageNode.querySelector('canvas');
            if (canvas && canvas.parentNode) {
                canvas.parentNode.insertBefore(overlayContainer, canvas.nextSibling);
            }
            else {
                pageNode.appendChild(overlayContainer);
            }
        }
        // Clear existing to avoid duplicates on fast re-renders
        overlayContainer.innerHTML = '';
        highlightsForThisPage.forEach(highlight => {
            this.drawHighlightRects(highlight, overlayContainer);
        });
    }
    drawHighlightRects(highlight, container) {
        highlight.rects.forEach((rect, idx) => {
            const div = document.createElement('div');
            div.className = 'pdf-highlight-rect';
            div.setAttribute('data-highlight-id', highlight.id);
            div.style.position = 'absolute';
            div.style.left = `${rect.pLeft * 100}%`;
            div.style.top = `${rect.pTop * 100}%`;
            div.style.width = `${rect.pWidth * 100}%`;
            div.style.height = `${rect.pHeight * 100}%`;
            div.style.backgroundColor = `rgba(${highlight.color}, ${highlight.opacity})`;
            div.style.mixBlendMode = 'multiply'; // Makes the highlight look much better over text
            container.appendChild(div);
        });
    }
    renderHighlightSingle(highlight) {
        this.currentHighlights.push(highlight); // Cache it
        // Find the active page node in the DOM and render just this one without reloading everything
        const pages = document.querySelectorAll(`.page[data-page-number="${highlight.page}"]`);
        pages.forEach(page => {
            this.renderHighlightsForPageNode(page);
        });
    }
    updateSettings(settings) {
        this.settings = settings;
    }
    cleanupObserver() {
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
    }
    cleanup() {
        this.cleanupObserver();
        this.activePdfPath = null;
        this.currentHighlights = [];
    }
    unload() {
        this.cleanup();
        // Remove all rendered overlays from DOM
        document.querySelectorAll('.pdf-highlighter-overlay-container').forEach(el => el.remove());
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiT3ZlcmxheUluamVjdG9yLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiT3ZlcmxheUluamVjdG9yLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFJQSxNQUFNLE9BQU8sZUFBZTtJQVF4QixZQUFZLEdBQVEsRUFBRSxLQUF5QixFQUFFLFFBQWdDO1FBSmpGLGtCQUFhLEdBQWtCLElBQUksQ0FBQztRQUNwQyxhQUFRLEdBQTRCLElBQUksQ0FBQztRQUN6QyxzQkFBaUIsR0FBcUIsRUFBRSxDQUFDO1FBR3JDLElBQUksQ0FBQyxHQUFHLEdBQUcsR0FBRyxDQUFDO1FBQ2YsSUFBSSxDQUFDLEtBQUssR0FBRyxLQUFLLENBQUM7UUFDbkIsSUFBSSxDQUFDLFFBQVEsR0FBRyxRQUFRLENBQUM7SUFDN0IsQ0FBQztJQUVELGlCQUFpQjtRQUNiLCtEQUErRDtRQUMvRCxJQUFJLENBQUMsR0FBRyxDQUFDLFNBQVMsQ0FBQyxFQUFFLENBQUMsb0JBQW9CLEVBQUUsQ0FBTyxJQUEwQixFQUFFLEVBQUU7WUFDN0UsSUFBSSxDQUFDLElBQUk7Z0JBQUUsT0FBTztZQUNsQixNQUFNLElBQUksR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDO1lBQ3ZCLE1BQU0sSUFBSSxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsU0FBUyxDQUFDLGFBQWEsRUFBRSxDQUFDO1lBRWhELElBQUksSUFBSSxDQUFDLFdBQVcsRUFBRSxLQUFLLEtBQUssSUFBSSxJQUFJLElBQUksSUFBSSxDQUFDLFNBQVMsS0FBSyxLQUFLLEVBQUUsQ0FBQztnQkFDbkUsTUFBTSxJQUFJLENBQUMsaUJBQWlCLENBQUMsSUFBSSxFQUFFLElBQUksQ0FBQyxXQUFXLENBQUMsQ0FBQztZQUN6RCxDQUFDO2lCQUFNLENBQUM7Z0JBQ0osSUFBSSxDQUFDLE9BQU8sRUFBRSxDQUFDO1lBQ25CLENBQUM7UUFDTCxDQUFDLENBQUEsQ0FBQyxDQUFDO0lBQ1AsQ0FBQztJQUVLLGlCQUFpQixDQUFDLElBQVcsRUFB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QUMsV0FBVztRQUVuRCw2RkFBNkY7UUFDN0YsTUFBTSxLQUFLLEdBQUcsUUFBUSxDQUFDLGdCQUFnQixDQUFDLDJCQUEyQixTQUFTLENBQUMsSUFBSSxJQUFJLENBQUMsQ0FBQztRQUN2RixLQUFLLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxFQUFFO1lBQ2pCLElBQUksQ0FBQywyQkFBMkIsQ0FBQyxJQUFtQixDQUFDLENBQUM7UUFDMUQsQ0FBQyxDQUFDLENBQUM7SUFDUCxDQUFDO0lBRUQsY0FBYyxDQUFDLFFBQWdDO1FBQzNDLElBQUksQ0FBQyxRQUFRLEdBQUcsUUFBUSxDQUFDO0lBQzdCLENBQUM7SUFFRCxlQUFlO1FBQ1gsSUFBSSxJQUFJLENBQUMsUUFBUSxFQUFFLENBQUM7WUFDaEIsSUFBSSxDQUFDLFFBQVEsQ0FBQyxVQUFVLEVBQUUsQ0FBQztZQUMzQixJQUFJLENBQUMsUUFBUSxHQUFHLElBQUksQ0FBQztRQUN6QixDQUFDO0lBQ0wsQ0FBQztJQUVELE9BQU87UUFDSCxJQUFJLENBQUMsZUFBZSxFQUFFLENBQUM7UUFDdkIsSUFBSSxDQUFDLGFBQWEsR0FBRyxJQUFJLENBQUM7UUFDMUIsSUFBSSxDQUFDLGlCQUFpQixHQUFHLEVBQUUsQ0FBQztJQUNoQyxDQUFDO0lBRUQsTUFBTTtRQUNGLElBQUksQ0FBQyxPQUFPLEVBQUUsQ0FBQztRQUNmLHdDQUF3QztRQUN4QyxRQUFRLENBQUMsZ0JBQWdCLENBQUMsb0NBQW9DLENBQUMsQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsTUFBTSxFQUFFLENBQUMsQ0FBQztJQUMvRixDQUFDO0NBQ0oiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBBcHAsIFdvcmtzcGFjZUxlYWYsIFRGaWxlIH0gZnJvbSAnb2JzaWRpYW4nO1xuaW1wb3J0IHsgSGlnaGxpZ2h0SnNvblN0b3JlLCBIaWdobGlnaHRNb2RlbCB9IGZyb20gJy4uL3N0b3JhZ2UvSGlnaGxpZ2h0SnNvblN0b3JlJztcbmltcG9ydCB7IFBkZkhpZ2hsaWdodGVyU2V0dGluZ3MgfSBmcm9tICcuLi9tYWluJztcblxuZXhwb3J0IGNsYXNzIE92ZXJsYXlJbmplY3RvciB7XG4gICAgYXBwOiBBcHA7XG4gICAgc3RvcmU6IEhpZ2hsaWdodEpzb25TdG9yZTtcbiAgICBzZXR0aW5nczogUGRmSGlnaGxpZ2h0ZXJTZXR0aW5ncztcbiAgICBhY3RpdmVQZGZQYXRoOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICBvYnNlcnZlcjogTXV0YXRpb25PYnNlcnZlciB8IG51bGwgPSBudWxsO1xuICAgIGN1cnJlbnRIaWdobGlnaHRzOiBIaWdobGlnaHRNb2RlbFtdID0gW107XG5cbiAgICBjb25zdHJ1Y3RvcihhcHA6IEFwcCwgc3RvcmU6IEhpZ2hsaWdodEpzb25TdG9yZSwgc2V0dGluZ3M6IFBkZkhpZ2hsaWdodGVyU2V0dGluZ3MpIHtcbiAgICAgICAgdGhpcy5hcHAgPSBhcHA7XG4gICAgICAgIHRoaXMuc3RvcmUgPSBzdG9yZTtcbiAgICAgICAgdGhpcy5zZXR0aW5ncyA9IHNldHRpbmdzO1xuICAgIH1cblxuICAgIHJlZ2lzdGVyTGlzdGVuZXJzKCkge1xuICAgICAgICAvLyBMaXN0ZW4gdG8gYWN0aXZlIGxlYWYgY2hhbmdlcyB0byBkZXRlY3Qgd2hlbiBhIFBERiBpcyBvcGVuZWRcbiAgICAgICAgdGhpcy5hcHAud29ya3NwYWNlLm9uKCdhY3RpdmUtbGVhZi1jaGFuZ2UnLCBhc3luYyAobGVhZjogV29ya3NwYWNlTGVhZiB8IG51bGwpID0+IHtcbiAgICAgICAgICAgIGlmICghbGVhZikgcmV0dXJuO1xuICAgICAgICAgICAgY29uc3QgdmlldyA9IGxlYWYudmlldztcbiAgICAgICAgICAgIGNvbnN0IGZpbGUgPSB0aGlzLmFwcC53b3Jrc3BhY2UuZ2V0QWN0aXZlRmlsZSgpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAodmlldy5nZXRWaWV3VHlwZSgpID09PSAncGRmJyAmJiBmaWxlICYmIGZpbGUuZXh0ZW5zaW9uID09PSAncGRmJykge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuaW5pdE92ZXJsYXlTeXN0ZW0oZmlsZSwgdmlldy5jb250YWluZXJFbCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRoaXMuY2xlYW51cCgpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBhc3luYyBpbml0T3ZlcmxheVN5c3RlbShmaWxlOiBURmlsZSwgY29udGFpbmVyOiBIVE1MRWxlbWVudCkge1xuICAgICAgICB0aGlzLmFjdGl2ZVBkZlBhdGggPSBmaWxlLnBhdGg7XG4gICAgICAgIHRoaXMuY3VycmVudEhpZ2hsaWdodHMgPSBhd2FpdCB0aGlzLnN0b3JlLmxvYWRIaWdobGlnaHRzKHRoaXMuYWN0aXZlUGRmUGF0aCk7XG4gICAgICAgIFxuICAgICAgICB0aGlzLmNsZWFudXBPYnNlcnZlcigpO1xuXG4gICAgICAgIC8vIFBERnMgcmVuZGVyIGFzeW5jaHJvbm91c2x5IGFuZCBkeW5hbWljYWxseSBhcyB0aGUgdXNlciBzY3JvbGxzLlxuICAgICAgICAvLyBXZSBtdXN0IHdhdGNoIHRoZSBET00gZm9yIG5ldyBgLnBhZ2VgIGRpdnMgYmVpbmcgYXR0YWNoZWQgYnkgcGRmLmpzXG4gICAgICAgIHRoaXMub2JzZXJ2ZXIgPSBuZXcgTXV0YXRpb25PYnNlcnZlcigobXV0YXRpb25zKSA9PiB7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IG11dGF0aW9uIG9mIG11dGF0aW9ucykge1xuICAgICAgICAgICAgICAgIGlmIChtdXRhdGlvbi50eXBlID09PSAnY2hpbGRMaXN0Jykge1xuICAgICAgICAgICAgICAgICAgICBtdXRhdGlvbi5hZGRlZE5vZGVzLmZvckVhY2goKG5vZGUpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChub2RlLm5vZGVUeXBlID09PSBOb2RlLkVMRU1FTlRfTk9ERSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGVsID0gbm9kZSBhcyBIVE1MRWxlbWVudDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyBDaGVjayBpZiBhIG5ldyBwYWdlIGNvbnRhaW5lciB3YXMgYWRkZWQgb3IgYSBjaGlsZCBpbnNpZGUgYSBwYWdlIHdhcyByZW5kZXJlZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChlbC5jbGFzc0xpc3QgJiYgZWwuY2xhc3NMaXN0LmNvbnRhaW5zKCdwYWdlJykpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5yZW5kZXJIaWdobGlnaHRzRm9yUGFnZU5vZGUoZWwpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoZWwuY2xhc3NMaXN0ICYmIGVsLmNsYXNzTGlzdC5jb250YWlucygndGV4dExheWVyJykpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gU29tZXRpbWVzIHRoZSBwYWdlIGV4aXN0cyBidXQgdGhlIHRleHRMYXllciBtb3VudHMgbGF0ZXJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgcGFyZW50ID0gZWwuY2xvc2VzdCgnLnBhZ2UnKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHBhcmVudCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5yZW5kZXJIaWdobGlnaHRzRm9yUGFnZU5vZGUocGFyZW50IGFzIEhUTUxFbGVtZW50KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICAvLyBTZWFyY2ggdGhlIGN1cnJlbnQgRE9NIGluIGNhc2UgdGhleSBhcmUgYWxyZWFkeSByZW5kZXJlZCBiZWZvcmUgdGhlIG11dGF0aW9uIG9ic2VydmVyIGZpcmVzXG4gICAgICAgIGNvbnN0IGV4aXN0aW5nUGFnZXMgPSBjb250YWluZXIucXVlcnlTZWxlY3RvckFsbCgnLnBhZ2UnKTtcbiAgICAgICAgZXhpc3RpbmdQYWdlcy5mb3JFYWNoKG5vZGUgPT4gdGhpcy5yZW5kZXJIaWdobGlnaHRzRm9yUGFnZU5vZGUobm9kZSBhcyBIVE1MRWxlbWVudCkpO1xuXG4gICAgICAgIHRoaXMub2JzZXJ2ZXIub2JzZXJ2ZShjb250YWluZXIsIHtcbiAgICAgICAgICAgIGNoaWxkTGlzdDogdHJ1ZSxcbiAgICAgICAgICAgIHN1YnRyZWU6IHRydWVcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgcmVuZGVySGlnaGxpZ2h0c0ZvclBhZ2VOb2RlKHBhZ2VOb2RlOiBIVE1MRWxlbWVudCkge1xuICAgICAgICBjb25zdCBwYWdlTnVtU3RyID0gcGFnZU5vZGUuZ2V0QXR0cmlidXRlKCdkYXRhLXBhZ2UtbnVtYmVyJyk7XG4gICAgICAgIGlmICghcGFnZU51bVN0cikgcmV0dXJuO1xuICAgICAgICBjb25zdCBwYWdlTnVtID0gcGFyc2VJbnQocGFnZU51bVN0ciwgMTApO1xuXG4gICAgICAgIGNvbnN0IGhpZ2hsaWdodHNGb3JUaGlzUGFnZSA9IHRoaXMuY3VycmVudEhpZ2hsaWdodHMuZmlsdGVyKGggPT4gaC5wYWdlID09PSBwYWdlTnVtKTtcbiAgICAgICAgaWYgKGhpZ2hsaWdodHNGb3JUaGlzUGFnZS5sZW5ndGggPT09IDApIHJldHVybjtcblxuICAgICAgICAvLyBFbnN1cmUgd2Ugb25seSByZW5kZXIgb25jZSBwZXIgaGlnaGxpZ2h0IHBlciBub2RlIHRvIGF2b2lkIGR1cGxpY2F0aW9uIGlmIG9ic2VydmVycyBmaXJlIGRlbnNlbHlcbiAgICAgICAgY29uc3Qgb3ZlcmxheUNvbnRhaW5lcklkID0gYHBkZi1oaWdobGlnaHRlci1sYXllci0ke3BhZ2VOdW19YDtcbiAgICAgICAgbGV0IG92ZXJsYXlDb250YWluZXIgPSBwYWdlTm9kZS5xdWVyeVNlbGVjdG9yKGAjJHtvdmVybGF5Q29udGFpbmVySWR9YCkgYXMgSFRNTEVsZW1lbnQ7XG4gICAgICAgIFxuICAgICAgICBpZiAoIW92ZXJsYXlDb250YWluZXIpIHtcbiAgICAgICAgICAgIG92ZXJsYXlDb250YWluZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICAgICAgICAgIG92ZXJsYXlDb250YWluZXIuaWQgPSBvdmVybGF5Q29udGFpbmVySWQ7XG4gICAgICAgICAgICBvdmVybGF5Q29udGFpbmVyLmNsYXNzTmFtZSA9ICdwZGYtaGlnaGxpZ2h0ZXItb3ZlcmxheS1jb250YWluZXInO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICAvLyBDcml0aWNhbCBTZXR1cDogV2Ugd2FudCB0aGlzIGRpdiB0byBzaXQgYWJzb2x1dGUsIGNvdmVyaW5nIHRoZSBwYWdlLCBcbiAgICAgICAgICAgIC8vIGJ1dCBVTkRFUiB0aGUgaW52aXNpYmxlIHRleHRMYXllciAod2hpY2ggdXN1YWxseSBoYXMgei1pbmRleCAyKSwgYW5kIE9WRVIgdGhlIGNhbnZhcyAoei1pbmRleCAxKS5cbiAgICAgICAgICAgIG92ZXJsYXlDb250YWluZXIuc3R5bGUucG9zaXRpb24gPSAnYWJzb2x1dGUnO1xuICAgICAgICAgICAgb3ZlcmxheUNvbnRhaW5lci5zdHlsZS50b3AgPSAnMCc7XG4gICAgICAgICAgICBvdmVybGF5Q29udGFpbmVyLnN0eWxlLmxlZnQgPSAnMCc7XG4gICAgICAgICAgICBvdmVybGF5Q29udGFpbmVyLnN0eWxlLndpZHRoID0gJzEwMCUnO1xuICAgICAgICAgICAgb3ZlcmxheUNvbnRhaW5lci5zdHlsZS5oZWlnaHQgPSAnMTAwJSc7XG4gICAgICAgICAgICBvdmVybGF5Q29udGFpbmVyLnN0eWxlLnpJbmRleCA9ICcxJzsgXG4gICAgICAgICAgICBvdmVybGF5Q29udGFpbmVyLnN0eWxlLnBvaW50ZXJFdmVudHMgPSAnbm9uZSc7IC8vIEVzc2VudGlhbCBzbyBpdCBkb2Vzbid0IGJsb2NrIHRleHQgc2VsZWN0aW9uXG5cbiAgICAgICAgICAgIC8vIEZpbmQgdGhlIGNhbnZhcyB0byBpbnNlcnQgcmlnaHQgYWZ0ZXIgaXRcbiAgICAgICAgICAgIGNvbnN0IGNhbnZhcyA9IHBhZ2VOb2RlLnF1ZXJ5U2VsZWN0b3IoJ2NhbnZhcycpO1xuICAgICAgICAgICAgaWYgKGNhbnZhcyAmJiBjYW52YXMucGFyZW50Tm9kZSkge1xuICAgICAgICAgICAgICAgIGNhbnZhcy5wYXJlbnROb2RlLmluc2VydEJlZm9yZShvdmVybGF5Q29udGFpbmVyLCBjYW52YXMubmV4dFNpYmxpbmcpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBwYWdlTm9kZS5hcHBlbmRDaGlsZChvdmVybGF5Q29udGFpbmVyKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8vIENsZWFyIGV4aXN0aW5nIHRvIGF2b2lkIGR1cGxpY2F0ZXMgb24gZmFzdCByZS1yZW5kZXJzXG4gICAgICAgIG92ZXJsYXlDb250YWluZXIuaW5uZXJIVE1MID0gJyc7XG5cbiAgICAgICAgaGlnaGxpZ2h0c0ZvclRoaXNQYWdlLmZvckVhY2goaGlnaGxpZ2h0ID0+IHtcbiAgICAgICAgICAgIHRoaXMuZHJhd0hpZ2hsaWdodFJlY3RzKGhpZ2hsaWdodCwgb3ZlcmxheUNvbnRhaW5lcik7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIGRyYXdIaWdobGlnaHRSZWN0cyhoaWdobGlnaHQ6IEhpZ2hsaWdodE1vZGVsLCBjb250YWluZXI6IEhUTUxFbGVtZW50KSB7XG4gICAgICAgIGhpZ2hsaWdodC5yZWN0cy5mb3JFYWNoKChyZWN0LCBpZHgpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGRpdiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgICAgICAgICAgZGl2LmNsYXNzTmFtZSA9ICdwZGYtaGlnaGxpZ2h0LXJlY3QnO1xuICAgICAgICAgICAgZGl2LnNldEF0dHJpYnV0ZSgnZGF0YS1oaWdobGlnaHQtaWQnLCBoaWdobGlnaHQuaWQpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBkaXYuc3R5bGUucG9zaXRpb24gPSAnYWJzb2x1dGUnO1xuICAgICAgICAgICAgZGl2LnN0eWxlLmxlZnQgPSBgJHtyZWN0LnBMZWZ0ICogMTAwfSVgO1xuICAgICAgICAgICAgZGl2LnN0eWxlLnRvcCA9IGAke3JlY3QucFRvcCAqIDEwMH0lYDtcbiAgICAgICAgICAgIGRpdi5zdHlsZS53aWR0aCA9IGAke3JlY3QucFdpZHRoICogMTAwfSVgO1xuICAgICAgICAgICAgZGl2LnN0eWxlLmhlaWdodCA9IGAke3JlY3QucEhlaWdodCAqIDEwMH0lYDtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgZGl2LnN0eWxlLmJhY2tncm91bmRDb2xvciA9IGByZ2JhKCR7aGlnaGxpZ2h0LmNvbG9yfSwgJHtoaWdobGlnaHQub3BhY2l0eX0pYDtcbiAgICAgICAgICAgIGRpdi5zdHlsZS5taXhCbGVuZE1vZGUgPSAnbXVsdGlwbHknOyAvLyBNYWtlcyB0aGUgaGlnaGxpZ2h0IGxvb2sgbXVjaCBiZXR0ZXIgb3ZlciB0ZXh0XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnRhaW5lci5hcHBlbmRDaGlsZChkaXYpO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICByZW5kZXJIaWdobGlnaHRTaW5nbGUoaGlnaGxpZ2h0OiBIaWdobGlnaHRNb2RlbCkge1xuICAgICAgICB0aGlzLmN1cnJlbnRIaWdobGlnaHRzLnB1c2goaGlnaGxpZ2h0KTsgLy8gQ2FjaGUgaXRcbiAgICAgICAgXG4gICAgICAgIC8vIEZpbmQgdGhlIGFjdGl2ZSBwYWdlIG5vZGUgaW4gdGhlIERPTSBhbmQgcmVuZGVyIGp1c3QgdGhpcyBvbmUgd2l0aG91dCByZWxvYWRpbmcgZXZlcnl0aGluZ1xuICAgICAgICBjb25zdCBwYWdlcyA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoYC5wYWdlW2RhdGEtcGFnZS1udW1iZXI9XCIke2hpZ2hsaWdodC5wYWdlfVwiXWApO1xuICAgICAgICBwYWdlcy5mb3JFYWNoKHBhZ2UgPT4ge1xuICAgICAgICAgICAgdGhpcy5yZW5kZXJIaWdobGlnaHRzRm9yUGFnZU5vZGUocGFnZSBhcyBIVE1MRWxlbWVudCk7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIHVwZGF0ZVNldHRpbmdzKHNldHRpbmdzOiBQZGZIaWdobGlnaHRlclNldHRpbmdzKSB7XG4gICAgICAgIHRoaXMuc2V0dGluZ3MgPSBzZXR0aW5ncztcbiAgICB9XG5cbiAgICBjbGVhbnVwT2JzZXJ2ZXIoKSB7XG4gICAgICAgIGlmICh0aGlzLm9ic2VydmVyKSB7XG4gICAgICAgICAgICB0aGlzLm9ic2VydmVyLmRpc2Nvbm5lY3QoKTtcbiAgICAgICAgICAgIHRoaXMub2JzZXJ2ZXIgPSBudWxsO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgY2xlYW51cCgpIHtcbiAgICAgICAgdGhpcy5jbGVhbnVwT2JzZXJ2ZXIoKTtcbiAgICAgICAgdGhpcy5hY3RpdmVQZGZQYXRoID0gbnVsbDtcbiAgICAgICAgdGhpcy5jdXJyZW50SGlnaGxpZ2h0cyA9IFtdO1xuICAgIH1cblxuICAgIHVubG9hZCgpIHtcbiAgICAgICAgdGhpcy5jbGVhbnVwKCk7XG4gICAgICAgIC8vIFJlbW92ZSBhbGwgcmVuZGVyZWQgb3ZlcmxheXMgZnJvbSBET01cbiAgICAgICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnBkZi1oaWdobGlnaHRlci1vdmVybGF5LWNvbnRhaW5lcicpLmZvckVhY2goZWwgPT4gZWwucmVtb3ZlKCkpO1xuICAgIH1cbn1cbiJdfQ==
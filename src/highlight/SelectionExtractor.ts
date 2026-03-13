export interface RectOverlay {
  pLeft: number;
  pTop: number;
  pWidth: number;
  pHeight: number;
}

export interface HighlightOutput {
  pageNumber: number;
  rects: RectOverlay[];
  text: string;
}

export class SelectionExtractor {
  getActiveSelection(): HighlightOutput | null {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return null;
    }

    const range = selection.getRangeAt(0);

    // Walk up DOM to find the .page div
    let currentNode: Node | null = range.startContainer;
    let pageDiv: HTMLElement | null = null;

    while (currentNode) {
      if (currentNode.nodeType === Node.ELEMENT_NODE) {
        const el = currentNode as HTMLElement;
        if (el.classList && el.classList.contains("page")) {
          pageDiv = el;
          break;
        }
      }
      currentNode = currentNode.parentNode;
    }

    if (!pageDiv) return null;

    const pageNumberAttr = pageDiv.getAttribute("data-page-number");
    if (!pageNumberAttr) return null;
    const pageNumber = parseInt(pageNumberAttr, 10);

    // Use the canvas as the reference frame (not the .page wrapper div)
    // because the textLayer spans are positioned over the canvas, not the
    // outer .page div which has extra padding and a CSS drop-shadow.
    const canvas = pageDiv.querySelector("canvas");
    const textLayer = pageDiv.querySelector(".textLayer") as HTMLElement | null;
    const referenceEl: HTMLElement = canvas ?? textLayer ?? pageDiv;
    const pageRect = referenceEl.getBoundingClientRect();

    if (pageRect.width === 0 || pageRect.height === 0) return null;

    // ── THE CORE FIX: per-text-node sub-ranges ────────────────────────────
    //
    // WHY range.getClientRects() was wrong:
    //
    // PDF.js renders each text chunk as a single <span> that can cover an
    // entire line. When your selection touches that span — even for just
    // two words — getClientRects() returns the rect for the WHOLE span,
    // not just the selected characters. This made partial line selections
    // highlight the entire line.
    //
    // THE FIX:
    // Walk every TEXT NODE covered by the range individually. For each one,
    // create a fresh sub-Range covering only the selected characters inside
    // that node. Calling getClientRects() on this sub-Range returns a rect
    // for exactly those characters, regardless of how wide their parent
    // <span> is.
    //
    // This is the same approach browser devtools use internally to draw the
    // blue selection highlight — character-accurate, not span-accurate.
    // ─────────────────────────────────────────────────────────────────────
    const rawRects: RectOverlay[] = [];
    const textNodes = this.getTextNodesInRange(range);

    for (const node of textNodes) {
      // Determine which slice of this text node is selected
      const isStart = node === range.startContainer;
      const isEnd = node === range.endContainer;

      const startOffset = isStart ? range.startOffset : 0;
      const endOffset = isEnd
        ? range.endOffset
        : (node.textContent?.length ?? 0);

      // Skip degenerate slices (empty text, cursor-only positions)
      if (startOffset >= endOffset) continue;

      // Build a sub-range covering only the selected characters
      const subRange = document.createRange();
      try {
        subRange.setStart(node, startOffset);
        subRange.setEnd(node, endOffset);
      } catch {
        continue; // node was detached from DOM between frames
      }

      const subRects = subRange.getClientRects();
      for (let i = 0; i < subRects.length; i++) {
        const rect = subRects[i];
        if (!rect || rect.width < 1 || rect.height < 1) continue;

        const pLeft = (rect.left - pageRect.left) / pageRect.width;
        const pTop = (rect.top - pageRect.top) / pageRect.height;
        const pWidth = rect.width / pageRect.width;
        const pHeight = rect.height / pageRect.height;

        // Drop rects that fall outside the canvas area (can happen at
        // extreme zoom or on cross-page selections)
        if (pLeft < -0.01 || pTop < -0.01 || pLeft > 1.01 || pTop > 1.01)
          continue;

        rawRects.push({
          pLeft: Math.max(0, pLeft),
          pTop: Math.max(0, pTop),
          pWidth: Math.min(pWidth, 1 - Math.max(0, pLeft)),
          pHeight: Math.min(pHeight, 1 - Math.max(0, pTop)),
        });
      }

      subRange.detach();
    }

    if (rawRects.length === 0) return null;

    const mergedRects = this.mergeRects(rawRects);
    const text = selection.toString();

    return { pageNumber, rects: mergedRects, text };
  }

  // ── Walk all Text nodes that the range touches ────────────────────────────
  private getTextNodesInRange(range: Range): Text[] {
    const nodes: Text[] = [];

    // Fast path: selection is entirely within a single text node
    if (
      range.startContainer === range.endContainer &&
      range.startContainer.nodeType === Node.TEXT_NODE
    ) {
      return [range.startContainer as Text];
    }

    // Walk the subtree of the common ancestor, collecting text nodes
    // that fall within [startContainer … endContainer]
    const walker = document.createTreeWalker(
      range.commonAncestorContainer,
      NodeFilter.SHOW_TEXT,
      null,
    );

    let started = false;
    let node: Node | null;

    while ((node = walker.nextNode())) {
      if (node === range.startContainer) started = true;
      if (started && node.nodeType === Node.TEXT_NODE) {
        nodes.push(node as Text);
      }
      if (node === range.endContainer) break;
    }

    return nodes;
  }

  // ── Merge rects on the same visual line ──────────────────────────────────
  //
  // Even with per-character rects, a single word can produce multiple tiny
  // rects (one per glyph cluster in some PDF.js builds). We still merge
  // rects that share the same baseline into one clean highlight block,
  // which prevents opacity-stacking artifacts on overlapping edges.
  // ─────────────────────────────────────────────────────────────────────────
  private mergeRects(rects: RectOverlay[]): RectOverlay[] {
    // Sort top-to-bottom, then left-to-right
    rects.sort((a, b) => {
      if (Math.abs(a.pTop - b.pTop) > 0.004) return a.pTop - b.pTop;
      return a.pLeft - b.pLeft;
    });

    const merged: RectOverlay[] = [];
    let line: RectOverlay[] = [rects[0]!];

    for (let i = 1; i < rects.length; i++) {
      const rect = rects[i]!;
      const prev = line[line.length - 1]!;

      // Same line: vertical overlap within ~1.5% of page height,
      // AND horizontally close/touching (not a gap between columns)
      const sameLineY = Math.abs(rect.pTop - prev.pTop) < 0.015;
      const closeEnoughX = rect.pLeft <= prev.pLeft + prev.pWidth + 0.01;

      if (sameLineY && closeEnoughX) {
        line.push(rect);
      } else {
        merged.push(this.mergeLineRects(line));
        line = [rect];
      }
    }
    if (line.length > 0) merged.push(this.mergeLineRects(line));

    return merged;
  }

  private mergeLineRects(line: RectOverlay[]): RectOverlay {
    const minLeft = Math.min(...line.map((r) => r.pLeft));
    const maxRight = Math.max(...line.map((r) => r.pLeft + r.pWidth));
    const minTop = Math.min(...line.map((r) => r.pTop));
    const maxBottom = Math.max(...line.map((r) => r.pTop + r.pHeight));

    return {
      pLeft: minLeft,
      pTop: minTop,
      pWidth: maxRight - minLeft,
      pHeight: maxBottom - minTop,
    };
  }
}

# AnnotatePDF by bishwaa

**AnnotatePDF by bishwaa** is a premium Obsidian plugin that transforms Obsidian into a true academic PDF reader. It delivers **Highlight Precision** while writing **true native PDF annotations** directly into the `.pdf` binary file — making your highlights permanently portable across Adobe Acrobat, Foxit Reader, and any other standards-compliant PDF viewer.

---

## 🚀 Key Features

### 1. Zero-Flicker Delayed Cache Engine

Traditional PDF annotation plugins that write directly to the file on every highlight cause Obsidian to violently reload and flicker the PDF viewer with each change. **AnnotatePDF eliminates this completely.**

When you highlight text, the plugin bypasses disk I/O entirely and injects a temporary CSS overlay directly onto your screen in **0 milliseconds**. The true native annotations are batched into a high-speed memory queue. Only when you switch tabs, close the file, or close Obsidian will the plugin lock the PDF binary, write all queued highlights in a single pass, and save the file natively in the background — no flicker, no interruption.

### 2. Pixel-Perfect Highlight Alignment

AnnotatePDF uses a **canvas-anchored coordinate engine** to position highlights with surgical accuracy at any zoom level.

Standard approaches measure selection rects against the outer `.page` wrapper div, which includes CSS padding and Obsidian's drop-shadow — causing highlights to appear shifted or misaligned from the actual text. AnnotatePDF instead measures against the **canvas element directly**, which is the true rendering surface that PDF.js positions its text layer over. The result is highlights that sit perfectly on top of your selected text at every zoom level.

### 3. Character-Accurate Partial Line Selection

Selecting a few words from the middle or end of a line highlights **exactly those words** — nothing more.

PDF.js renders text as large span elements, sometimes covering an entire line in a single chunk. Standard web APIs (`range.getClientRects()`) return the bounding rect of the whole span when touched, causing partial selections to highlight the full line. AnnotatePDF uses a **per-text-node sub-range engine** — it walks every individual text node in the selection and builds a fresh sub-range for the exact selected characters within each node. This is the same character-level method browsers use internally to draw their own blue selection highlight.

### 4. Multi-Color Hotkey Support

Stop clicking through menus to change highlight colors. AnnotatePDF supports rapid hotkey-driven highlighting straight out of the box. Simply select text and press one of the global hotkeys:

| Key | Color     | Default          |
| --- | --------- | ---------------- |
| `H` | Primary   | Yellow `#ffff00` |
| `G` | Secondary | Green `#00ff00`  |
| `J` | Tertiary  | Cyan `#00ffff`   |

Configure your exact hex colors in the plugin settings.

### 5. Instant Native Deletion

Made a mistake? Select any text that overlaps a highlight and press **`Delete`** or **`Backspace`**.

- **Unsaved highlights** — instantly removed from the CSS layer with zero disk writes
- **Saved highlights** — the plugin reads the annotation directly from the PDF binary, locates it by position, and permanently removes it from the `/Annot` tree in a single atomic write

Deletion uses a **dual-path matching system** for maximum reliability:

- **Exact NM match** — fast O(1) lookup using the annotation's unique ID embedded in the PDF at write time
- **Spatial fallback** — overlap-based coordinate matching with ±2pt floating-point tolerance, using the highlight's own stored rect (not the cursor rect), for annotations created or re-saved by external readers that strip custom fields

### 6. PDF as the Single Source of Truth

AnnotatePDF follows the same architecture as Foxit Reader: **the PDF binary itself is the authoritative record** of all annotations. There are no fragile sidecar JSON files or external databases that can fall out of sync.

When deleting a saved highlight, the plugin reads annotation metadata directly from the PDF binary via `readAnnotationsFromPdf()`. This means deletion works correctly even after:

- Obsidian restarts
- The file being opened and re-saved in Foxit or Acrobat
- The internal tracking cache being cleared or corrupted

### 7. Password-Protected PDF Handling

AnnotatePDF detects encrypted PDFs immediately and handles them gracefully:

- **Instant feedback** — attempting to highlight a password-protected PDF shows a `🔒` notice immediately at the keypress, before any work is queued
- **No error spam** — detected encrypted files are added to a session blocklist. The flush loop skips them permanently, so you never see a flood of repeated error toasts after closing the file or restarting Obsidian
- **Queue safety** — the pending queue for an encrypted file is cleared on detection. Unlike file-lock failures (which keep the queue for retry), retrying an encrypted PDF is pointless, so all queued highlights are discarded cleanly

To annotate a previously blocked file after removing its password, use **Reset Cache** in plugin settings.

### 8. Background Locking Resilience

If your PDF is open in Adobe Acrobat or Foxit Reader simultaneously, those applications place an OS-level lock on the file preventing external writes. **AnnotatePDF is immune to data loss in this scenario.**

If the plugin detects a file lock during flush, it shows a specific `❌` notice and **refuses to clear the queue**. Your highlights remain safely cached in Obsidian's persistent memory. Once you close the other application and switch tabs, the plugin resumes saving automatically.

Error types are handled distinctly:

| Scenario                  | Message                             | Queue                            |
| ------------------------- | ----------------------------------- | -------------------------------- |
| PDF open in another app   | `❌ File is locked by another app`  | **Kept** — retried on next flush |
| PDF is password-protected | `🔒 File is password-protected`     | **Cleared** — never retried      |
| Unknown error             | `⚠️ Failed to save — check console` | Kept                             |

### 9. Seamless Multi-Line Highlight Merging

When highlighting across multiple lines of wrapping text, the browser returns dozens of overlapping fragmented rectangles — one per text node fragment, per line. Overlapping rects cause uneven opacity densities that look unprofessional.

AnnotatePDF uses a **line-merging engine** that sorts all raw rects by baseline, groups them into lines by vertical proximity, and welds each line into a single clean bounding rectangle. The result is uniformly opaque highlight blocks across even the most complex multi-paragraph selections.

### 10. Crash-Safe Queue Persistence

All pending (unflushed) highlights and deletions are continuously serialized into Obsidian's `data.json` via `syncPendingQueueToDisk()`. If Obsidian is force-killed, crashes, or is closed via the OS `X` button before a flush can complete, your unsaved annotations are fully recovered on the next startup automatically.

---

## ⚙️ Installation

1. Copy `main.js`, `manifest.json`, and `styles.css` into your vault at:
   ```
   .obsidian/plugins/annotate-pdf-bishwaa/
   ```
2. Enable the plugin under **Settings → Community Plugins**.
3. Configure your preferred author name, highlight colors, and opacity.

---

## 📌 Usage Workflow

1. Open any `.pdf` file in your Obsidian vault
2. Select text using your mouse cursor
3. Press `H`, `G`, or `J` to instantly deploy the highlight
4. Continue reading — your highlights are cached and safe
5. Switch tabs or close the file — the plugin silently writes all annotations natively into the PDF binary in a single pass

To **remove** a highlight: select any text overlapping it and press `Delete` or `Backspace`.

---

## ⚙️ Settings

| Setting               | Description                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Author Name**       | Embedded in every annotation. Visible on hover in Foxit/Acrobat.                                                                                       |
| **Primary Color**     | Hotkey `H`. Default: Yellow                                                                                                                            |
| **Secondary Color**   | Hotkey `G`. Default: Green                                                                                                                             |
| **Tertiary Color**    | Hotkey `J`. Default: Cyan                                                                                                                              |
| **Highlight Opacity** | Global alpha multiplier (0–100). Applied to all colors.                                                                                                |
| **Reset Cache**       | Clears all pending queues, the JSON audit log, and the encrypted-file blocklist. Use this if you remove a password from a PDF and want to annotate it. |

---

## 🏗️ Architecture Overview

```
Keypress (H / G / J)
  └── SelectionExtractor         canvas-anchored, per-text-node sub-ranges
        └── drawTemporaryCssOverlay    0ms visual feedback
        └── pendingHighlights queue    persisted to data.json

Tab switch / file close
  └── flushCache() [concurrency-safe, _isFlushing guard]
        └── PdfAnnotator.applyBatchUpdatesToPdf()
              ├── EncryptedPdfError → clear queue, add to blocklist
              ├── LockedPdfError    → keep queue, notify user
              └── success           → clear queue, write JSON audit log

Delete / Backspace
  └── executeRemoveHighlight()
        ├── pending queue?  → remove CSS overlay, clear from queue
        └── saved in PDF?   → PdfAnnotator.readAnnotationsFromPdf()
                                  └── exact NM match + spatial fallback
                                        └── applyBatchUpdatesToPdf()
```

---

## 🔗 Compatibility

- Highlights are written as standard ISO 32000 `/Highlight` annotations
- Fully visible and editable in **Foxit Reader**, **Adobe Acrobat**, **PDF Expert**, and all other standards-compliant readers
- Works on any PDF that is not password-protected
- Tested on Obsidian desktop (Windows, macOS, Linux)

---

_Transform Obsidian into a true academic PDF reader — by bishwaa_

<div align="center">

**Built with ❤️ by Bishwaa Adhikarii, Nepal🇳🇵**

_If this plugin made your reading life better, I'd love to hear from you._

|     |                                                                                      |
| :-: | :----------------------------------------------------------------------------------- |
| 🌐  | **Website** — [bishwaa.com.np](http://bishwaa.com.np/)                               |
| 💼  | **LinkedIn** — [linkedin.com/in/iambishwaa](https://www.linkedin.com/in/iambishwaa/) |
| 🐙  | **GitHub** — [github.com/iambishwaa](https://github.com/iambishwaa)                  |
| 📬  | **Say thanks** — [pi@bishwaa.com.np](mailto:pi@bishwaa.com.np)                       |

---

_If AnnotatePDF saved you time, a kind email or a ⭐ on GitHub goes a long way. Thank you for using it!_

</div>

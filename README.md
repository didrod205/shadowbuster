# ShadowBuster 🕶️

**That black redaction bar isn't redaction — it's a sticker.** Drop a PDF, Excel, Word, PowerPoint, or screenshot and ShadowBuster surfaces the parts that were hidden but *never actually removed*: text under black boxes, very-hidden spreadsheet tabs, deleted tracked changes, the uncropped original of a cropped image, white-on-white text. **100% in your browser — nothing is uploaded.**

> Stop trusting black rectangles.

### 🌐 [**Drop a file and watch the "deleted" parts come back →**](https://didrod205.github.io/shadowbuster/)

```bash
# scan a whole folder of "redacted" documents from your terminal:
npx shadowbuster ./documents
```

```
■ redacted-report.pdf  (pdf, 1 KB)
  ■ Text hidden under a redaction box — page 1
    A filled rectangle is painted over this text, but the text itself is
    still in the page's content stream — selectable, copyable, recovered here.
    ┌ recovered:
    Jane Doe 123-45-6789 $240,000

————————————————————————————————————————————————
Scanned 1 file(s) — 1 still carries hidden content, 1 with text behind a redaction.
```

## Why

"Redacting" a document by **drawing a black box over a name**, **hiding a worksheet**, **cropping an image**, or **deleting a sentence with Track Changes on** removes *nothing*. The original is still sitting in the bytes you email out — one copy-paste, one right-click → Unhide, or one "Accept all changes" away from anyone who receives it. This has leaked court filings, settlement figures, troop names, and executive comp over and over.

ShadowBuster is the **before-you-hit-send** check. Drop the file; it shows you exactly what's recoverable, so you can really remove it — and it does this **entirely in your browser**, because a tool for finding secrets in your documents should never upload your documents.

## What it finds

| File | What's still in there |
| --- | --- |
| **PDF** | Text painted under a filled "redaction" rectangle, and text drawn in the same color as the box on top of it (invisible-text trick) |
| **Excel** (`.xlsx`) | Hidden and **very-hidden** worksheets (+ their cells), hidden columns/rows with data, cached pivot-table source rows |
| **Word** (`.docx`) | Tracked-change **deletions** that were never accepted, hidden (vanished) text, review comments |
| **PowerPoint** (`.pptx`) | Speaker notes, and the **full uncropped original** of any image the slide only shows a crop of |
| **PNG / JPEG** | A whole second image (or data) **appended after the file's end marker** — the "cropped/overwritten screenshot still has the original" failure |
| **Office, all** | Author / `lastModifiedBy` / company metadata, and every embedded full-resolution image |

## How it works

```
drag a file in
   └─ sniff magic bytes ─┬─ %PDF  → brute-force object scan → FlateDecode (built-in DecompressionStream)
                         │          → tokenize content stream, track matrices + fill rectangles
                         │          → decode glyphs via the font's /ToUnicode CMap
                         │          → text whose anchor sits under a filled box = recovered
                         ├─ PK..  → ZIP central directory → inflate XML → read OOXML structure
                         └─ PNG/JPEG → walk to the logical end marker → recover trailing bytes
```

- **Zero dependencies.** The whole engine is hand-written TypeScript using only platform APIs (`DecompressionStream`, `DataView`, `TextDecoder`). No `pdf.js`, no office libraries, nothing to audit but the source. That's the point — you can read every line before you trust it with a sensitive file.
- **Nothing leaves your machine.** The browser version reads the dropped file with `FileReader` and parses it locally; there is no upload, no backend, no network call. The CLI reads from disk. Same pure core (`src/`) in both.
- **No false guesses.** If a PDF uses embedded subset fonts with no `/ToUnicode` map, the text under a box can't be reliably decoded — ShadowBuster says so rather than printing garbage.

## Honesty & scope

ShadowBuster reveals what a document **already exposes to anyone who opens it** with the right click or a text selection. It is an **awareness tool, not an exploit**: it reads public structure of a file you already have. It does not break encryption, defeat *proper* redaction (where the content was actually deleted and the file flattened), or recover pixels that were genuinely discarded.

The v1 PDF detector targets the most common and most damaging failure — **real text sitting under a filled rectangle**. Exotic cases (composite fonts with no `/ToUnicode`, vector-outlined text, scanned images) are reported as undecodable rather than guessed. Use it on **your own** files before you share them.

## To *actually* redact

- **PDF:** use a real redaction tool that deletes the underlying text, or flatten/print the page to an image.
- **Excel:** delete the hidden/very-hidden sheets and clear hidden rows/columns — don't just hide them.
- **Word:** accept all tracked changes, then *Inspect Document → Remove* comments and hidden text.
- **PowerPoint:** re-crop then compress images (this discards cropped pixels); delete speaker notes.
- **Images:** re-export to a fresh file; never overwrite a larger image in place.

## Library

```ts
import { scanBytes } from "shadowbuster";

const result = await scanBytes("report.pdf", new Uint8Array(buffer));
for (const f of result.findings) {
  console.log(f.severity, f.title, f.location);
  if (f.recovered?.type === "text") console.log(f.recovered.text);
}
```

`scanBytes` is pure and isomorphic — give it bytes, get back typed `findings`. Works in the browser, in Node, in a worker.

## CLI

```bash
npm i -g shadowbuster          # then:  shadowbuster ./documents
# or zero-install:
npx shadowbuster report.pdf
npx shadowbuster ./folder --json
```

Exits non-zero when it finds text/data behind a redaction, so you can wire it into a pre-send or CI check. `unredact` is a shorter alias.

## Contributing

New detector ideas welcome — DOCX `customXml` leftovers, EXIF/GPS in embedded images, PDF annotation/form-field values, ODF formats. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT © [didrod205](https://github.com/didrod205)

---

<sub>It was never redacted. It was just hidden. ShadowBuster shows you the difference — locally, before you send.</sub>

## 💖 Sponsor

Find this useful? [**Sponsor on GitHub**](https://github.com/sponsors/didrod205) — it keeps these tools maintained.

[![Sponsor](https://img.shields.io/badge/Sponsor-GitHub-db61a2?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/didrod205)

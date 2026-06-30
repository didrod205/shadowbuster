// Office Open XML analyzer. .xlsx/.docx/.pptx are ZIP archives of XML, and they
// routinely carry content that the author believes is gone but isn't:
//   - hidden and "very hidden" worksheets (only removable via VBA)
//   - hidden columns/rows (the classic "salaries in column G" leak)
//   - tracked-change deletions still sitting in document.xml
//   - hidden (vanished) text and review comments
//   - the *full, uncropped* original of any image that was merely cropped
//   - speaker notes and author/lastModifiedBy metadata
//
// We extract with targeted regex over the (machine-generated, regular) XML —
// zero-dependency and good enough for surfacing these payloads.

import type { Archive } from "./zip.js";
import type { Finding, FileKind } from "./types.js";

const IMG_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  emf: "image/emf",
  wmf: "image/wmf",
  tiff: "image/tiff",
  tif: "image/tiff",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Pull an attribute value out of a single start-tag string. */
function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`));
  return m ? decodeEntities(m[1]!) : null;
}

/** Concatenate the text of every <…t>…</…t> run inside a fragment. */
function runText(xml: string, localName: string): string {
  const re = new RegExp(`<(?:\\w+:)?${localName}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${localName}>`, "g");
  let out = "";
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out += decodeEntities(m[1]!);
  return out;
}

function colLetterToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

// ---------------------------------------------------------------------------
// Shared strings + worksheet cell extraction
// ---------------------------------------------------------------------------

function parseSharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  const out: string[] = [];
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(runText(m[1]!, "t"));
  return out;
}

interface Cell {
  ref: string;
  col: number;
  value: string;
}

function parseCells(sheetXml: string, shared: string[]): Cell[] {
  const cells: Cell[] = [];
  const re = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sheetXml))) {
    const tag = (m[1] ?? m[3] ?? "");
    const body = m[2] ?? "";
    const ref = attr(`<c ${tag}>`, "r") ?? "";
    const t = attr(`<c ${tag}>`, "t");
    let value = "";
    if (t === "s") {
      const idx = parseInt(runText(body, "v") || "-1", 10);
      value = shared[idx] ?? "";
    } else if (t === "inlineStr") {
      value = runText(body, "t");
    } else {
      value = runText(body, "v");
    }
    if (value === "") continue;
    const colLetters = ref.match(/^[A-Za-z]+/)?.[0] ?? "";
    cells.push({ ref, col: colLetterToIndex(colLetters), value });
  }
  return cells;
}

function dumpCells(cells: Cell[], limit = 200): string {
  return cells
    .slice(0, limit)
    .map((c) => `${c.ref}: ${c.value}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Spreadsheets
// ---------------------------------------------------------------------------

async function analyzeXlsx(a: Archive, findings: Finding[]): Promise<void> {
  const workbook = await a.text("xl/workbook.xml");
  const rels = await a.text("xl/_rels/workbook.xml.rels");
  const shared = parseSharedStrings(await a.text("xl/sharedStrings.xml"));
  if (!workbook) return;

  // r:id -> worksheet path
  const relMap = new Map<string, string>();
  if (rels) {
    const re = /<Relationship\b([^>]*)\/>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(rels))) {
      const id = attr(`<r ${m[1]}>`, "Id");
      const target = attr(`<r ${m[1]}>`, "Target");
      if (id && target) relMap.set(id, target.replace(/^\/?/, "").replace(/^xl\//, ""));
    }
  }

  const sheetRe = /<sheet\b([^>]*)\/>/g;
  let sm: RegExpExecArray | null;
  while ((sm = sheetRe.exec(workbook))) {
    const tag = `<s ${sm[1]}>`;
    const name = attr(tag, "name") ?? "(unnamed)";
    const state = attr(tag, "state") ?? "visible";
    if (state === "visible") continue;

    const rid = attr(tag, "r:id") ?? attr(tag, "id") ?? "";
    let target = relMap.get(rid) ?? "";
    if (target && !target.startsWith("worksheets/")) target = target.replace(/^.*?(worksheets\/)/, "$1");
    const path = target ? `xl/${target}` : "";
    const sheetXml = path ? await a.text(path) : null;
    const cells = sheetXml ? parseCells(sheetXml, shared) : [];

    findings.push({
      kind: state === "veryHidden" ? "xlsx.very-hidden-sheet" : "xlsx.hidden-sheet",
      title:
        state === "veryHidden"
          ? `Very-hidden worksheet "${name}"`
          : `Hidden worksheet "${name}"`,
      severity: "critical",
      summary:
        state === "veryHidden"
          ? `A "very hidden" sheet — invisible in Excel's unhide menu, removable only via the VBA editor — is still in this file with ${cells.length} non-empty cells.`
          : `A hidden sheet is still in this file with ${cells.length} non-empty cells. One right-click → Unhide brings it back.`,
      location: `sheet "${name}" (${state})`,
      recovered: cells.length ? { type: "text", text: dumpCells(cells) } : undefined,
    });
  }

  // Hidden columns / rows across all worksheets.
  for (const sheetPath of a.match(/^xl\/worksheets\/sheet\d+\.xml$/)) {
    const xml = await a.text(sheetPath);
    if (!xml) continue;
    const hiddenCols: Array<[number, number]> = [];
    const colRe = /<col\b([^>]*)\/?>/g;
    let cm: RegExpExecArray | null;
    while ((cm = colRe.exec(xml))) {
      const tag = `<c ${cm[1]}>`;
      if (attr(tag, "hidden") === "1") {
        const min = parseInt(attr(tag, "min") ?? "0", 10);
        const max = parseInt(attr(tag, "max") ?? "0", 10);
        if (min) hiddenCols.push([min, max || min]);
      }
    }
    const hiddenRows = (xml.match(/<row\b[^>]*\bhidden="1"[^>]*>/g) ?? []).length;

    if (hiddenCols.length) {
      const shared2 = shared;
      const cells = parseCells(xml, shared2);
      const inHidden = (col: number) => hiddenCols.some(([lo, hi]) => col >= lo && col <= hi);
      const leaked = cells.filter((c) => inHidden(c.col));
      findings.push({
        kind: "xlsx.hidden-columns",
        title: `Hidden column${hiddenCols.length > 1 ? "s" : ""} with data`,
        severity: leaked.length ? "warning" : "info",
        summary: leaked.length
          ? `${hiddenCols.length} hidden column range(s) hold ${leaked.length} non-empty cells — the data is right there, just not displayed.`
          : `${hiddenCols.length} hidden column range(s).`,
        location: sheetPath.replace("xl/worksheets/", ""),
        recovered: leaked.length ? { type: "text", text: dumpCells(leaked) } : undefined,
      });
    }
    if (hiddenRows) {
      findings.push({
        kind: "xlsx.hidden-rows",
        title: `${hiddenRows} hidden row${hiddenRows > 1 ? "s" : ""}`,
        severity: "info",
        summary: `${hiddenRows} row(s) are hidden but their values remain in the sheet.`,
        location: sheetPath.replace("xl/worksheets/", ""),
      });
    }
  }

  // Stale pivot-cache data: a pivot table caches its full source rows, which
  // can include rows the visible pivot filters out.
  for (const p of a.match(/^xl\/pivotCache\/pivotCacheRecords\d+\.xml$/)) {
    const xml = await a.text(p);
    if (!xml) continue;
    const vals = new Set<string>();
    const re = /<(?:s|n)\b[^>]*\bv="([^"]*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml))) vals.add(decodeEntities(m[1]!));
    if (vals.size) {
      findings.push({
        kind: "xlsx.pivot-cache",
        title: "Cached pivot-table source data",
        severity: "info",
        summary: `A pivot cache retains ${vals.size} distinct source values — these persist even if the source rows were deleted.`,
        location: p.replace("xl/pivotCache/", ""),
        recovered: { type: "text", text: [...vals].slice(0, 200).join("\n") },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Word documents
// ---------------------------------------------------------------------------

async function analyzeDocx(a: Archive, findings: Finding[]): Promise<void> {
  const doc = await a.text("word/document.xml");
  if (doc) {
    // Tracked-change deletions: text someone "removed" that is still present.
    let deleted = "";
    const delRe = /<w:del\b[\s\S]*?<\/w:del>/g;
    let m: RegExpExecArray | null;
    while ((m = delRe.exec(doc))) deleted += runText(m[0], "delText");
    if (deleted.trim()) {
      findings.push({
        kind: "docx.tracked-deletion",
        title: "Deleted text (tracked changes not accepted)",
        severity: "critical",
        summary: `Text marked as deleted is still in the document because the tracked changes were never accepted. Anyone can turn on "All Markup" and read it.`,
        recovered: { type: "text", text: deleted.trim() },
      });
    }

    // Hidden (vanished) text.
    let hidden = "";
    const runRe = /<w:r\b[\s\S]*?<\/w:r>/g;
    while ((m = runRe.exec(doc))) {
      if (/<w:vanish\b[^>]*\/?>/.test(m[0]) && !/<w:vanish\b[^>]*w:val="(?:0|false)"/.test(m[0])) {
        hidden += runText(m[0], "t");
      }
    }
    if (hidden.trim()) {
      findings.push({
        kind: "docx.hidden-text",
        title: "Hidden text",
        severity: "warning",
        summary: `Text formatted as "hidden" is still stored in the file and reappears when hidden text is shown or the doc is converted to PDF/HTML.`,
        recovered: { type: "text", text: hidden.trim() },
      });
    }
  }

  // Review comments.
  const comments = await a.text("word/comments.xml");
  if (comments) {
    const items: string[] = [];
    const re = /<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(comments))) {
      const author = attr(`<c ${m[1]}>`, "w:author") ?? "?";
      const text = runText(m[2]!, "t").trim();
      if (text) items.push(`${author}: ${text}`);
    }
    if (items.length) {
      findings.push({
        kind: "docx.comments",
        title: `${items.length} review comment${items.length > 1 ? "s" : ""}`,
        severity: "warning",
        summary: `Internal review comments are still embedded in the document.`,
        recovered: { type: "text", text: items.join("\n") },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// PowerPoint
// ---------------------------------------------------------------------------

async function analyzePptx(a: Archive, findings: Finding[]): Promise<void> {
  let notesText = "";
  for (const p of a.match(/^ppt\/notesSlides\/notesSlide\d+\.xml$/)) {
    const xml = await a.text(p);
    if (xml) {
      const t = runText(xml, "t").trim();
      if (t) notesText += `[${p.replace("ppt/notesSlides/", "")}] ${t}\n`;
    }
  }
  if (notesText.trim()) {
    findings.push({
      kind: "pptx.speaker-notes",
      title: "Speaker notes",
      severity: "info",
      summary: `Presenter notes are embedded in the deck — often the candid version of what the slide says politely.`,
      recovered: { type: "text", text: notesText.trim() },
    });
  }
}

// ---------------------------------------------------------------------------
// Shared across all OOXML: cropped images, embedded media, author metadata
// ---------------------------------------------------------------------------

async function analyzeMedia(a: Archive, findings: Finding[]): Promise<void> {
  // Does any drawing crop an image? <a:srcRect l=".." t=".." r=".." b=".."/>
  let cropDetected = false;
  for (const p of a.match(/\.(xml)$/)) {
    if (!/(document|sheet\d+|slide\d+|drawing\d+)\.xml$/.test(p)) continue;
    const xml = await a.text(p);
    if (xml && /<a:srcRect\b[^>]*(?:\bl|\bt|\br|\bb)="/.test(xml)) {
      cropDetected = true;
      break;
    }
  }

  const media = a.match(/\/media\/[^/]+\.(png|jpe?g|gif|bmp|webp|tiff?)$/i);
  let surfaced = 0;
  for (const p of media) {
    if (surfaced >= 24) break;
    const ext = p.split(".").pop()!.toLowerCase();
    const bytes = await a.bytes(p);
    if (!bytes) continue;
    surfaced++;
    findings.push({
      kind: cropDetected ? "ooxml.cropped-image" : "ooxml.embedded-image",
      title: cropDetected ? "Embedded image (full, uncropped original)" : "Embedded image",
      severity: cropDetected ? "warning" : "info",
      summary: cropDetected
        ? `This document crops at least one image for display, but the *entire original* image is stored inside the file. Cropping in Office hides pixels, it doesn't delete them.`
        : `Full-resolution embedded image — including any metadata it still carries.`,
      location: p.replace(/^.*\/media\//, "media/"),
      recovered: { type: "image", mime: IMG_MIME[ext] ?? "application/octet-stream", bytes, cropped: cropDetected },
    });
  }
}

async function analyzeMetadata(a: Archive, findings: Finding[]): Promise<void> {
  const core = await a.text("docProps/core.xml");
  if (!core) return;
  const creator = runText(core, "dc:creator").trim();
  const lastBy = runText(core, "cp:lastModifiedBy").trim();
  const parts: string[] = [];
  if (creator) parts.push(`Created by: ${creator}`);
  if (lastBy && lastBy !== creator) parts.push(`Last modified by: ${lastBy}`);
  const app = await a.text("docProps/app.xml");
  if (app) {
    const company = runText(app, "Company").trim();
    if (company) parts.push(`Company: ${company}`);
  }
  if (parts.length) {
    findings.push({
      kind: "ooxml.author-metadata",
      title: "Author / origin metadata",
      severity: "info",
      summary: `The document still names who really wrote and last touched it.`,
      recovered: { type: "text", text: parts.join("\n") },
    });
  }
}

/** Detect which OOXML flavor an archive is. */
function detectKind(a: Archive): FileKind {
  if (a.has("xl/workbook.xml")) return "xlsx";
  if (a.has("word/document.xml")) return "docx";
  if (a.has("ppt/presentation.xml")) return "pptx";
  return "ooxml";
}

export async function analyzeOoxml(
  a: Archive,
): Promise<{ kind: FileKind; findings: Finding[]; notes: string[] }> {
  const findings: Finding[] = [];
  const notes: string[] = [];
  const kind = detectKind(a);

  if (kind === "xlsx") await analyzeXlsx(a, findings);
  else if (kind === "docx") await analyzeDocx(a, findings);
  else if (kind === "pptx") await analyzePptx(a, findings);

  await analyzeMedia(a, findings);
  await analyzeMetadata(a, findings);

  return { kind, findings, notes };
}

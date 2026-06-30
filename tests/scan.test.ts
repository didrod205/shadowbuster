import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { scanBytes, type ScanResult } from "../src/index.js";

const FIX = join(import.meta.dirname, "..", "fixtures");

async function scan(name: string): Promise<ScanResult> {
  return scanBytes(name, new Uint8Array(await readFile(join(FIX, name))));
}
const kinds = (r: ScanResult) => r.findings.map((f) => f.kind);
const recovered = (r: ScanResult, kind: string) => {
  const f = r.findings.find((x) => x.kind === kind);
  return f?.recovered?.type === "text" ? f.recovered.text : "";
};

describe("PDF redaction", () => {
  it("recovers text painted under a black box", async () => {
    const r = await scan("redacted-report.pdf");
    expect(r.kind).toBe("pdf");
    expect(kinds(r)).toContain("pdf.redaction");
    const text = recovered(r, "pdf.redaction");
    expect(text).toContain("Jane Doe");
    expect(text).toContain("123-45-6789");
    expect(text).toContain("$240,000");
  });

  it("does not flag the non-redacted line", async () => {
    const r = await scan("redacted-report.pdf");
    expect(recovered(r, "pdf.redaction")).not.toContain("redacted for privacy");
  });
});

describe("xlsx hidden sheets", () => {
  it("surfaces a very-hidden worksheet and its cells", async () => {
    const r = await scan("quarterly-figures.xlsx");
    expect(r.kind).toBe("xlsx");
    expect(kinds(r)).toContain("xlsx.very-hidden-sheet");
    const text = recovered(r, "xlsx.very-hidden-sheet");
    expect(text).toContain("Robert King");
    expect(text).toContain("$1,200,000");
  });
  it("reads author metadata", async () => {
    const r = await scan("quarterly-figures.xlsx");
    expect(recovered(r, "ooxml.author-metadata")).toContain("Finance Automation");
  });
});

describe("docx", () => {
  it("recovers tracked-change deletions, hidden text and comments", async () => {
    const r = await scan("settlement-draft.docx");
    expect(r.kind).toBe("docx");
    expect(recovered(r, "docx.tracked-deletion")).toContain("$5,000,000");
    expect(recovered(r, "docx.hidden-text")).toContain("verbally agreed");
    expect(recovered(r, "docx.comments")).toContain("the real figure");
  });
});

describe("pptx", () => {
  it("flags the full original behind a crop and the speaker notes", async () => {
    const r = await scan("investor-deck.pptx");
    expect(r.kind).toBe("pptx");
    expect(kinds(r)).toContain("ooxml.cropped-image");
    expect(recovered(r, "pptx.speaker-notes")).toContain("layoffs");
    const img = r.findings.find((f) => f.kind === "ooxml.cropped-image");
    expect(img?.recovered?.type).toBe("image");
  });
});

describe("image", () => {
  it("recovers a whole image appended after the end marker", async () => {
    const r = await scan("cropped-screenshot.png");
    expect(r.kind).toBe("png");
    expect(kinds(r)).toContain("image.appended-image");
    const f = r.findings.find((x) => x.kind === "image.appended-image");
    expect(f?.recovered?.type).toBe("image");
    if (f?.recovered?.type === "image") expect(f.recovered.bytes.length).toBeGreaterThan(40);
  });
});

describe("robustness", () => {
  it("returns a clean, typed result for an unrecognized file", async () => {
    const r = await scanBytes("notes.txt", new TextEncoder().encode("just some plain text, nothing hidden"));
    expect(r.kind).toBe("unknown");
    expect(r.findings).toHaveLength(0);
    expect(r.notes.join(" ")).toMatch(/Unrecognized/);
  });
});

// Top-level dispatcher: sniff the file type from its magic bytes and route to
// the right analyzer. Everything is pure and runs on a Uint8Array, so the same
// entry point serves the browser playground and the Node CLI.

import { openArchive } from "./zip.js";
import { analyzeOoxml } from "./ooxml.js";
import { analyzePdf } from "./pdf.js";
import { analyzeImage } from "./image.js";
import { emptyResult, type FileKind, type ScanResult } from "./types.js";

function sniff(b: Uint8Array): FileKind {
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "pdf"; // %PDF
  if (b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05)) return "ooxml"; // PK..
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  return "unknown";
}

export async function scanBytes(fileName: string, bytes: Uint8Array): Promise<ScanResult> {
  const kind = sniff(bytes);
  const result = emptyResult(fileName, kind, bytes.length);

  try {
    if (kind === "pdf") {
      const { findings, notes } = await analyzePdf(bytes);
      result.findings = findings;
      result.notes = notes;
    } else if (kind === "ooxml") {
      const archive = openArchive(bytes);
      const { kind: realKind, findings, notes } = await analyzeOoxml(archive);
      result.kind = realKind;
      result.findings = findings;
      result.notes = notes;
    } else if (kind === "png" || kind === "jpeg") {
      const { findings, notes } = analyzeImage(bytes);
      result.findings = findings;
      result.notes = notes;
    } else {
      result.notes.push("Unrecognized file type. ShadowBuster reads PDF, Office (xlsx/docx/pptx), PNG and JPEG.");
    }
  } catch (e) {
    result.notes.push(`Could not fully parse this file: ${(e as Error).message}`);
  }

  return result;
}

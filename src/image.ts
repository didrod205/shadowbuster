// Standalone image analyzer. The reliably-detectable cousin of "Acropalypse":
// many editors (and naive "crop"/"overwrite in place" flows) leave the original
// image's bytes *appended after the file's logical end*. A PNG ends at its IEND
// chunk; a JPEG ends at its EOI marker. Anything after that is data the file
// still carries but no viewer shows — sometimes the entire uncropped original.

import type { Finding } from "./types.js";

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(b: Uint8Array, sig: number[], at = 0): boolean {
  for (let i = 0; i < sig.length; i++) if (b[at + i] !== sig[i]) return false;
  return true;
}

/** Byte offset just past a PNG's IEND chunk, or -1. */
function pngLogicalEnd(b: Uint8Array): number {
  if (!startsWith(b, PNG_SIG)) return -1;
  let p = 8;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  while (p + 8 <= b.length) {
    const len = view.getUint32(p);
    const type = String.fromCharCode(b[p + 4]!, b[p + 5]!, b[p + 6]!, b[p + 7]!);
    const next = p + 12 + len; // length + type + data + crc
    if (type === "IEND") return Math.min(next, b.length);
    if (next <= p || next > b.length) return -1;
    p = next;
  }
  return -1;
}

/** Byte offset just past a JPEG's first EOI marker, or -1. */
function jpegLogicalEnd(b: Uint8Array): number {
  if (!(b[0] === 0xff && b[1] === 0xd8)) return -1;
  let p = 2;
  while (p + 1 < b.length) {
    if (b[p] !== 0xff) {
      p++;
      continue;
    }
    const marker = b[p + 1]!;
    if (marker === 0xd9) return p + 2; // EOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      p += 2; // standalone marker, no payload
      continue;
    }
    if (marker === 0xda) {
      // start of scan: skip its header, then walk entropy data to next marker
      const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
      const segLen = view.getUint16(p + 2);
      p += 2 + segLen;
      while (p + 1 < b.length) {
        if (b[p] === 0xff && b[p + 1] !== 0x00 && !(b[p + 1]! >= 0xd0 && b[p + 1]! <= 0xd7)) break;
        p++;
      }
      continue;
    }
    if (marker === 0xff) {
      p++;
      continue;
    }
    // marker with 2-byte length payload
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (p + 4 > b.length) break;
    const segLen = view.getUint16(p + 2);
    p += 2 + segLen;
  }
  return -1;
}

function findEmbedded(trailing: Uint8Array): { mime: string; bytes: Uint8Array } | null {
  for (let i = 0; i + 8 < trailing.length; i++) {
    if (startsWith(trailing, PNG_SIG, i)) return { mime: "image/png", bytes: trailing.subarray(i) };
    if (trailing[i] === 0xff && trailing[i + 1] === 0xd8 && trailing[i + 2] === 0xff)
      return { mime: "image/jpeg", bytes: trailing.subarray(i) };
  }
  return null;
}

function printable(b: Uint8Array): string {
  let s = "";
  for (const c of b.subarray(0, 4000)) s += c >= 32 && c < 127 ? String.fromCharCode(c) : c === 10 || c === 13 ? "\n" : "";
  return s.trim();
}

export function analyzeImage(bytes: Uint8Array): { findings: Finding[]; notes: string[] } {
  const findings: Finding[] = [];
  const notes: string[] = [];

  const end = startsWith(bytes, PNG_SIG) ? pngLogicalEnd(bytes) : jpegLogicalEnd(bytes);
  if (end < 0) return { findings, notes };

  const trailing = bytes.subarray(end);
  // Ignore a tiny trailing pad of nulls/newlines.
  if (trailing.length < 8 || trailing.every((c) => c === 0 || c === 10 || c === 13 || c === 32)) {
    return { findings, notes };
  }

  const embedded = findEmbedded(trailing);
  if (embedded) {
    findings.push({
      kind: "image.appended-image",
      title: "A whole second image is hidden after the end of this one",
      severity: "critical",
      summary: `${trailing.length.toLocaleString()} bytes follow this image's end marker, and they contain a complete second image. This is how a "cropped" or "overwritten" screenshot can still carry the full original.`,
      recovered: { type: "image", mime: embedded.mime, bytes: embedded.bytes.slice(), cropped: true },
    });
  } else {
    const text = printable(trailing);
    findings.push({
      kind: "image.trailing-data",
      title: "Hidden data after the image's end marker",
      severity: "warning",
      summary: `${trailing.length.toLocaleString()} bytes sit past this image's logical end — invisible to any viewer, but still in the file.`,
      recovered: text.length > 8 ? { type: "text", text } : undefined,
    });
  }

  return { findings, notes };
}

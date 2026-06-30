// A tiny, zero-dependency ZIP reader. OOXML files (.xlsx/.docx/.pptx) are just
// ZIP archives of XML + media, so this is all we need to crack them open in the
// browser. We read the central directory, then each local header, and inflate.
//
// Scope: the common case (stored + DEFLATE, < 4 GB, no ZIP64). That covers
// essentially every real Office document. Anything exotic is reported, not
// silently mangled.

import { inflateRaw } from "./inflate.js";

export interface ZipEntry {
  name: string;
  method: number; // 0 = stored, 8 = deflate
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

function u16(v: DataView, o: number): number {
  return v.getUint16(o, true);
}
function u32(v: DataView, o: number): number {
  return v.getUint32(o, true);
}

/** Locate the End Of Central Directory record by scanning backwards. */
function findEocd(view: DataView): number {
  // EOCD is 22 bytes minimum; the trailing comment is almost always empty.
  const min = 22;
  const max = Math.min(view.byteLength, 22 + 0xffff);
  for (let i = view.byteLength - min; i >= view.byteLength - max && i >= 0; i--) {
    if (u32(view, i) === EOCD_SIG) return i;
  }
  return -1;
}

/** Parse the central directory into a list of entries. Throws on a non-ZIP. */
export function readCentralDirectory(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view);
  if (eocd < 0) throw new Error("not a ZIP archive (no end-of-central-directory record)");

  const count = u16(view, eocd + 10);
  let p = u32(view, eocd + 16); // start of central directory
  const entries: ZipEntry[] = [];

  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.byteLength || u32(view, p) !== CDH_SIG) break;
    const method = u16(view, p + 10);
    const compressedSize = u32(view, p + 20);
    const uncompressedSize = u32(view, p + 24);
    const nameLen = u16(view, p + 28);
    const extraLen = u16(view, p + 30);
    const commentLen = u16(view, p + 32);
    const localHeaderOffset = u32(view, p + 42);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Extract and decompress a single entry's bytes. */
export async function extractEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const o = entry.localHeaderOffset;
  if (u32(view, o) !== LFH_SIG) throw new Error(`bad local header for ${entry.name}`);
  const nameLen = u16(view, o + 26);
  const extraLen = u16(view, o + 28);
  const dataStart = o + 30 + nameLen + extraLen;
  const data = bytes.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return data.slice();
  if (entry.method === 8) return inflateRaw(data);
  throw new Error(`unsupported ZIP compression method ${entry.method} for ${entry.name}`);
}

/** A lazily-extracting archive view: the whole ZIP, entry list, and helpers. */
export interface Archive {
  entries: ZipEntry[];
  has(name: string): boolean;
  /** Decompressed bytes for an entry, or null if absent. */
  bytes(name: string): Promise<Uint8Array | null>;
  /** Decompressed UTF-8 text for an entry, or null if absent. */
  text(name: string): Promise<string | null>;
  /** Entry names matching a predicate. */
  match(re: RegExp): string[];
}

export function openArchive(bytes: Uint8Array): Archive {
  const entries = readCentralDirectory(bytes);
  const byName = new Map(entries.map((e) => [e.name, e]));
  return {
    entries,
    has: (name) => byName.has(name),
    async bytes(name) {
      const e = byName.get(name);
      return e ? extractEntry(bytes, e) : null;
    },
    async text(name) {
      const e = byName.get(name);
      if (!e) return null;
      return new TextDecoder().decode(await extractEntry(bytes, e));
    },
    match: (re) => entries.map((e) => e.name).filter((n) => re.test(n)),
  };
}

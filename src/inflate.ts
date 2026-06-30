// DEFLATE / zlib decompression with zero dependencies. The fast path is the
// platform's built-in DecompressionStream; we fall back to a pure-JS inflater
// (inflate-js.ts) when it's unavailable — notably `deflate-raw`, which only
// reached Node in 20.12 / 21.2, so ZIP/OOXML parsing would otherwise break on
// older Node even though every modern browser supports it.
//
// - ZIP entries are *raw* DEFLATE (no zlib header)      -> inflateRaw
// - PDF FlateDecode streams are zlib-wrapped DEFLATE    -> inflateZlib

import { inflateRawJS } from "./inflate-js.js";

async function run(data: Uint8Array, format: CompressionFormat): Promise<Uint8Array> {
  const ds = new DecompressionStream(format);
  const copy = data.slice();
  const stream = new Blob([copy]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

let rawNative: boolean | null = null;
function supportsRaw(): boolean {
  if (rawNative !== null) return rawNative;
  try {
    // Constructing it is enough to probe support without decompressing.
    void new DecompressionStream("deflate-raw");
    rawNative = true;
  } catch {
    rawNative = false;
  }
  return rawNative;
}

export async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (supportsRaw()) {
    try {
      return await run(data, "deflate-raw");
    } catch {
      return inflateRawJS(data);
    }
  }
  return inflateRawJS(data);
}

function hasDecompressionStream(): boolean {
  return typeof DecompressionStream !== "undefined";
}

/**
 * Inflate a PDF stream. PDFs *should* be zlib-wrapped ("deflate"); some
 * producers emit raw streams. Use native zlib when available; otherwise inflate
 * in JS after stripping the 2-byte zlib header (the trailing adler32 checksum is
 * simply ignored by the inflater), falling back to treating it as raw.
 */
export async function inflateZlib(data: Uint8Array): Promise<Uint8Array> {
  if (hasDecompressionStream()) {
    try {
      return await run(data, "deflate");
    } catch {
      try {
        return await inflateRaw(data);
      } catch {
        /* fall through to JS */
      }
    }
  }
  try {
    return inflateRawJS(data.subarray(2));
  } catch {
    return inflateRawJS(data);
  }
}

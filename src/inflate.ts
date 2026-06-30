// DEFLATE / zlib decompression with zero dependencies, using the platform's
// built-in DecompressionStream. Available in modern browsers and in Node ≥18,
// so the exact same code runs in the playground and in the CLI.
//
// - ZIP entries are *raw* DEFLATE (no zlib header)      -> "deflate-raw"
// - PDF FlateDecode streams are zlib-wrapped DEFLATE    -> "deflate"

async function run(data: Uint8Array, format: CompressionFormat): Promise<Uint8Array> {
  const ds = new DecompressionStream(format);
  // Copy into a fresh ArrayBuffer-backed view so Blob/Response never sees a
  // SharedArrayBuffer or a sliced view with a surprising byteOffset.
  const copy = data.slice();
  const stream = new Blob([copy]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

export async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  return run(data, "deflate-raw");
}

/**
 * Inflate a PDF stream. PDFs *should* be zlib-wrapped ("deflate"), but some
 * producers emit raw streams; fall back to raw on a header error.
 */
export async function inflateZlib(data: Uint8Array): Promise<Uint8Array> {
  try {
    return await run(data, "deflate");
  } catch {
    return run(data, "deflate-raw");
  }
}

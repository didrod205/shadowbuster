import { describe, it, expect } from "vitest";
import { inflateRawJS } from "../src/inflate-js.js";

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate-raw");
  const stream = new Blob([bytes.slice()]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const enc = new TextEncoder();

describe("pure-JS DEFLATE inflate", () => {
  it("round-trips highly repetitive data (back-references)", async () => {
    const input = enc.encode("ShadowBuster ".repeat(500));
    const out = inflateRawJS(await deflateRaw(input));
    expect(out).toEqual(input);
  });

  it("round-trips realistic XML (dynamic Huffman)", async () => {
    const input = enc.encode(
      '<?xml version="1.0"?><sheet><c r="A1" t="s"><v>Robert King</v></c>' +
        '<c r="B1"><v>$1,200,000</v></c></sheet>'.repeat(40),
    );
    const out = inflateRawJS(await deflateRaw(input));
    expect(new TextDecoder().decode(out)).toBe(new TextDecoder().decode(input));
  });

  it("round-trips incompressible / high-entropy bytes", async () => {
    const input = new Uint8Array(4096);
    for (let i = 0; i < input.length; i++) input[i] = (i * 2654435761) & 0xff;
    const out = inflateRawJS(await deflateRaw(input));
    expect(out).toEqual(input);
  });

  it("round-trips an empty input", async () => {
    const out = inflateRawJS(await deflateRaw(new Uint8Array(0)));
    expect(out.length).toBe(0);
  });
});

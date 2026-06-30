// PDF redaction detector. The headline case: someone draws a black rectangle
// over a name in a PDF and ships it as "redacted" — but the text is still right
// there in the content stream, selectable and copyable. We reconstruct the
// text layer, track where each run is painted, and surface any run that sits
// under a filled rectangle (or is painted in the same color as the box on top
// of it — the invisible-text trick).
//
// Design choices for robustness over completeness (per the v1 scope):
//   - Brute-force object scan instead of trusting the xref table (survives the
//     broken/linearized/incrementally-updated PDFs that real documents are).
//   - FlateDecode via the platform DecompressionStream (zero-dep).
//   - Decode glyphs through the font's /ToUnicode CMap when present (this is
//     what makes subset/embedded fonts in real gov/court PDFs decodable);
//     fall back to WinAnsi/ASCII for simple fonts.
//   - Composite fonts with no ToUnicode are reported as "present but not
//     decodable" rather than guessed wrong.

import { inflateZlib } from "./inflate.js";
import type { Finding } from "./types.js";

// ---- byte/string helpers (latin1 keeps 1 char == 1 byte) -------------------

function latin1(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return s;
}
function bytesOf(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

// ---- matrices --------------------------------------------------------------

type Mat = [number, number, number, number, number, number];
const ID: Mat = [1, 0, 0, 1, 0, 0];
function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}
function apply(m: Mat, x: number, y: number): [number, number] {
  return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
}

// ---- object model ----------------------------------------------------------

interface PdfObject {
  num: number;
  dict: string; // text before `stream` (or the whole body for non-stream objs)
  streamStart: number; // byte offset into the file, or -1
  streamEnd: number;
}

function parseObjects(s: string): Map<number, PdfObject> {
  const map = new Map<number, PdfObject>();
  const re = /(\d+)\s+\d+\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const num = parseInt(m[1]!, 10);
    const bodyStart = m.index + m[0].length;
    const end = s.indexOf("endobj", bodyStart);
    if (end < 0) continue;
    const body = s.slice(bodyStart, end);
    const sIdx = body.search(/\bstream\b/);
    if (sIdx >= 0) {
      // stream data starts after the CRLF/LF that follows the `stream` keyword
      let dataStart = bodyStart + sIdx + "stream".length;
      if (s[dataStart] === "\r") dataStart++;
      if (s[dataStart] === "\n") dataStart++;
      let dataEnd = s.indexOf("endstream", dataStart);
      if (dataEnd < 0) dataEnd = end;
      // trim a single trailing EOL before endstream
      let e = dataEnd;
      if (s[e - 1] === "\n") e--;
      if (s[e - 1] === "\r") e--;
      map.set(num, { num, dict: body.slice(0, sIdx), streamStart: dataStart, streamEnd: e });
    } else {
      map.set(num, { num, dict: body, streamStart: -1, streamEnd: -1 });
    }
    re.lastIndex = end;
  }
  return map;
}

async function streamBytes(s: string, obj: PdfObject): Promise<Uint8Array> {
  const raw = bytesOf(s.slice(obj.streamStart, obj.streamEnd));
  if (/\/FlateDecode\b/.test(obj.dict)) {
    try {
      return await inflateZlib(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

// ---- dict value extraction (balanced) --------------------------------------

function valueAfter(dict: string, key: string): string | null {
  const i = dict.indexOf(key);
  if (i < 0) return null;
  let p = i + key.length;
  while (p < dict.length && /\s/.test(dict[p]!)) p++;
  if (dict.startsWith("<<", p)) return balanced(dict, p, "<<", ">>");
  if (dict[p] === "[") return balanced(dict, p, "[", "]");
  // ref "N G R", name "/X", or number/keyword
  const ref = dict.slice(p).match(/^(\d+)\s+(\d+)\s+R\b/);
  if (ref) return ref[0];
  const tok = dict.slice(p).match(/^(\/[^\s/<>\[\]()]+|[-+\d.]+|true|false|null)/);
  return tok ? tok[0] : null;
}

function balanced(s: string, start: number, open: string, close: string): string {
  let depth = 0;
  let p = start;
  while (p < s.length) {
    if (s.startsWith(open, p)) {
      depth++;
      p += open.length;
    } else if (s.startsWith(close, p)) {
      depth--;
      p += close.length;
      if (depth === 0) return s.slice(start, p);
    } else {
      p++;
    }
  }
  return s.slice(start);
}

function refNum(v: string | null): number | null {
  const m = v?.match(/^(\d+)\s+\d+\s+R\b/);
  return m ? parseInt(m[1]!, 10) : null;
}

// ---- ToUnicode CMap --------------------------------------------------------

function hexToStr(hex: string): string {
  const h = hex.replace(/[^0-9a-fA-F]/g, "");
  let out = "";
  for (let i = 0; i + 3 < h.length + (h.length % 4 === 0 ? 0 : 4); i += 4) {
    const unit = parseInt(h.slice(i, i + 4), 16);
    if (!Number.isNaN(unit)) out += String.fromCharCode(unit);
  }
  return out;
}

interface FontDecoder {
  twoByte: boolean;
  toUni: Map<number, string> | null;
  decodable: boolean;
}

function parseToUnicode(cmap: string): Map<number, string> {
  const map = new Map<number, string>();
  // bfchar: <src> <dst>
  for (const block of cmap.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block))) map.set(parseInt(m[1]!, 16), hexToStr(m[2]!));
  }
  // bfrange: <lo> <hi> <dst>   or   <lo> <hi> [<d0> <d1> ...]
  for (const block of cmap.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[\s\S]*?\]|<[0-9a-fA-F]+>)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block))) {
      const lo = parseInt(m[1]!, 16);
      const hi = parseInt(m[2]!, 16);
      const dst = m[3]!;
      if (dst.startsWith("[")) {
        const items = dst.match(/<([0-9a-fA-F]+)>/g) ?? [];
        for (let c = lo, k = 0; c <= hi && k < items.length; c++, k++) {
          map.set(c, hexToStr(items[k]!));
        }
      } else {
        const base = hexToStr(dst);
        const baseCode = base.charCodeAt(0);
        for (let c = lo; c <= hi; c++) {
          map.set(c, String.fromCharCode(baseCode + (c - lo)));
        }
      }
    }
  }
  return map;
}

async function buildFontDecoders(
  s: string,
  objs: Map<number, PdfObject>,
  fontDict: string,
): Promise<Map<string, FontDecoder>> {
  const decoders = new Map<string, FontDecoder>();
  const re = /\/([A-Za-z0-9.+\-_]+)\s+(\d+)\s+(\d+)\s+R/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fontDict))) {
    const name = m[1]!;
    const obj = objs.get(parseInt(m[2]!, 10));
    if (!obj) continue;
    const twoByte = /\/Subtype\s*\/Type0\b/.test(obj.dict);
    const tuNum = refNum(valueAfter(obj.dict, "/ToUnicode"));
    let toUni: Map<number, string> | null = null;
    if (tuNum != null && objs.has(tuNum)) {
      try {
        const cmap = latin1(await streamBytes(s, objs.get(tuNum)!));
        toUni = parseToUnicode(cmap);
      } catch {
        toUni = null;
      }
    }
    decoders.set(name, { twoByte, toUni, decodable: !twoByte || toUni != null });
  }
  return decoders;
}

function decodeShown(bytes: number[], font: FontDecoder | undefined): string {
  if (!font) {
    // assume simple ASCII
    return bytes.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : "")).join("");
  }
  if (font.twoByte) {
    if (!font.toUni) return "";
    let out = "";
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const code = bytes[i]! * 256 + bytes[i + 1]!;
      out += font.toUni.get(code) ?? "";
    }
    return out;
  }
  let out = "";
  for (const b of bytes) {
    out += font.toUni?.get(b) ?? (b >= 32 && b < 127 ? String.fromCharCode(b) : "");
  }
  return out;
}

// ---- content-stream tokenizer ---------------------------------------------

type Token =
  | { t: "num"; v: number }
  | { t: "str"; v: number[] }
  | { t: "name"; v: string }
  | { t: "arr"; v: Token[] }
  | { t: "op"; v: string };

function tokenize(s: string): Token[] {
  const toks: Token[] = [];
  let i = 0;
  const n = s.length;
  function readString(): number[] {
    // assumes s[i] === '('
    i++;
    let depth = 1;
    const out: number[] = [];
    while (i < n && depth > 0) {
      const c = s[i]!;
      if (c === "\\") {
        const nx = s[i + 1]!;
        const oct = s.slice(i + 1, i + 4).match(/^[0-7]{1,3}/);
        if (oct) {
          out.push(parseInt(oct[0], 8) & 0xff);
          i += 1 + oct[0].length;
          continue;
        }
        const map: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12 };
        if (nx in map) out.push(map[nx]!);
        else if (nx === "\n") {
          /* line continuation */
        } else if (nx === "\r") {
          if (s[i + 2] === "\n") i++;
        } else out.push(nx.charCodeAt(0) & 0xff);
        i += 2;
        continue;
      }
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
      out.push(c.charCodeAt(0) & 0xff);
      i++;
    }
    return out;
  }
  function readHex(): number[] {
    i++; // skip '<'
    let hex = "";
    while (i < n && s[i] !== ">") {
      if (/[0-9a-fA-F]/.test(s[i]!)) hex += s[i];
      i++;
    }
    i++; // skip '>'
    if (hex.length % 2) hex += "0";
    const out: number[] = [];
    for (let k = 0; k < hex.length; k += 2) out.push(parseInt(hex.slice(k, k + 2), 16));
    return out;
  }
  function readArray(): Token[] {
    i++; // skip '['
    const arr: Token[] = [];
    while (i < n && s[i] !== "]") {
      skipWs();
      if (s[i] === "]") break;
      const c = s[i]!;
      if (c === "(") arr.push({ t: "str", v: readString() });
      else if (c === "<" && s[i + 1] !== "<") arr.push({ t: "str", v: readHex() });
      else if (/[-+\d.]/.test(c)) arr.push({ t: "num", v: readNumber() });
      else i++;
    }
    i++; // skip ']'
    return arr;
  }
  function readNumber(): number {
    const m = s.slice(i, i + 32).match(/^[-+]?[\d.]+/);
    const v = m ? parseFloat(m[0]) : 0;
    i += m ? m[0].length : 1;
    return v;
  }
  function skipWs(): void {
    while (i < n && /[\s\0]/.test(s[i]!)) i++;
  }
  while (i < n) {
    skipWs();
    if (i >= n) break;
    const c = s[i]!;
    if (c === "%") {
      while (i < n && s[i] !== "\n") i++;
      continue;
    }
    if (c === "(") {
      toks.push({ t: "str", v: readString() });
    } else if (c === "<" && s[i + 1] === "<") {
      // dict — skip balanced
      let depth = 0;
      do {
        if (s.startsWith("<<", i)) {
          depth++;
          i += 2;
        } else if (s.startsWith(">>", i)) {
          depth--;
          i += 2;
        } else i++;
      } while (i < n && depth > 0);
    } else if (c === "<") {
      toks.push({ t: "str", v: readHex() });
    } else if (c === "[") {
      toks.push({ t: "arr", v: readArray() });
    } else if (c === "/") {
      const m = s.slice(i).match(/^\/[^\s/<>\[\]()]*/);
      toks.push({ t: "name", v: m ? m[0].slice(1) : "" });
      i += m ? m[0].length : 1;
    } else if (/[-+\d.]/.test(c)) {
      toks.push({ t: "num", v: readNumber() });
    } else {
      const m = s.slice(i).match(/^[A-Za-z'"*]+\d*/) ?? s.slice(i).match(/^[^\s]/);
      toks.push({ t: "op", v: m ? m[0] : c });
      i += m ? m[0].length : 1;
    }
  }
  return toks;
}

// ---- interpreter: find text under filled rectangles ------------------------

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  color: [number, number, number];
}
interface Span {
  text: string;
  x: number;
  y: number;
  color: [number, number, number];
}

function lum([r, g, b]: [number, number, number]): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}
function near(a: [number, number, number], b: [number, number, number]): boolean {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 0.15;
}

function interpret(toks: Token[], fonts: Map<string, FontDecoder>): { rects: Rect[]; spans: Span[] } {
  const rects: Rect[] = [];
  const spans: Span[] = [];
  let ctm: Mat = ID;
  const ctmStack: Mat[] = [];
  let fill: [number, number, number] = [0, 0, 0];
  const fillStack: Array<[number, number, number]> = [];
  let tlm: Mat = ID;
  let tm: Mat = ID;
  let font: FontDecoder | undefined;
  let pendingRects: Array<[number, number, number, number]> = [];
  const stack: Token[] = [];
  const nums = (k: number): number[] => stack.slice(-k).map((t) => (t.t === "num" ? t.v : 0));

  function show(bytes: number[]): void {
    const text = decodeShown(bytes, font);
    if (!text) return;
    const render = mul(tm, ctm);
    const [x, y] = [render[4], render[5]];
    spans.push({ text, x, y, color: fill });
  }

  for (const tk of toks) {
    if (tk.t !== "op") {
      stack.push(tk);
      continue;
    }
    const op = tk.v;
    switch (op) {
      case "cm": {
        const [a, b, c, d, e, f] = nums(6);
        ctm = mul([a!, b!, c!, d!, e!, f!], ctm);
        break;
      }
      case "q":
        ctmStack.push(ctm);
        fillStack.push(fill);
        break;
      case "Q":
        ctm = ctmStack.pop() ?? ctm;
        fill = fillStack.pop() ?? fill;
        break;
      case "re": {
        const [x, y, w, h] = nums(4);
        pendingRects.push([x!, y!, w!, h!]);
        break;
      }
      case "f":
      case "F":
      case "f*":
      case "b":
      case "b*":
      case "B":
      case "B*": {
        for (const [x, y, w, h] of pendingRects) {
          const pts = [apply(ctm, x, y), apply(ctm, x + w, y), apply(ctm, x + w, y + h), apply(ctm, x, y + h)];
          const xs = pts.map((p) => p[0]);
          const ys = pts.map((p) => p[1]);
          rects.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), color: fill });
        }
        pendingRects = [];
        break;
      }
      case "n":
      case "S":
      case "s":
        pendingRects = [];
        break;
      case "g": {
        const [v] = nums(1);
        fill = [v!, v!, v!];
        break;
      }
      case "rg": {
        const [r, g, b] = nums(3);
        fill = [r!, g!, b!];
        break;
      }
      case "k": {
        const [c, m, y, kk] = nums(4);
        fill = [(1 - c!) * (1 - kk!), (1 - m!) * (1 - kk!), (1 - y!) * (1 - kk!)];
        break;
      }
      case "sc":
      case "scn": {
        const ns = stack.filter((t) => t.t === "num").map((t) => (t as { v: number }).v);
        if (ns.length === 1) fill = [ns[0]!, ns[0]!, ns[0]!];
        else if (ns.length >= 3) fill = [ns[0]!, ns[1]!, ns[2]!];
        break;
      }
      case "BT":
        tlm = ID;
        tm = ID;
        break;
      case "Tf": {
        const nameTok = stack.filter((t) => t.t === "name").pop();
        if (nameTok && nameTok.t === "name") font = fonts.get(nameTok.v);
        break;
      }
      case "Td":
      case "TD": {
        const [tx, ty] = nums(2);
        tlm = mul([1, 0, 0, 1, tx!, ty!], tlm);
        tm = tlm;
        break;
      }
      case "Tm": {
        const [a, b, c, d, e, f] = nums(6);
        tlm = [a!, b!, c!, d!, e!, f!];
        tm = tlm;
        break;
      }
      case "T*":
        tlm = mul([1, 0, 0, 1, 0, -1], tlm);
        tm = tlm;
        break;
      case "Tj": {
        const st = stack[stack.length - 1];
        if (st?.t === "str") show(st.v);
        break;
      }
      case "'":
      case '"': {
        tlm = mul([1, 0, 0, 1, 0, -1], tlm);
        tm = tlm;
        const st = stack[stack.length - 1];
        if (st?.t === "str") show(st.v);
        break;
      }
      case "TJ": {
        const st = stack[stack.length - 1];
        if (st?.t === "arr") {
          const merged: number[] = [];
          for (const el of st.v) if (el.t === "str") merged.push(...el.v);
          show(merged);
        }
        break;
      }
      default:
        break;
    }
    stack.length = 0;
  }
  return { rects, spans };
}

function coveredText(rects: Rect[], spans: Span[]): string {
  const hidden: string[] = [];
  for (const sp of spans) {
    if (!sp.text.trim()) continue;
    for (const r of rects) {
      const pad = (r.y1 - r.y0) * 0.5 + 1;
      const inside = sp.x >= r.x0 - 1 && sp.x <= r.x1 + 1 && sp.y >= r.y0 - pad && sp.y <= r.y1 + pad;
      if (!inside) continue;
      const dark = lum(r.color) < 0.35;
      const invisible = near(sp.color, r.color);
      if (dark || invisible) {
        hidden.push(sp.text);
        break;
      }
    }
  }
  return hidden.join(" ").replace(/\s+/g, " ").trim();
}

// ---- page walk -------------------------------------------------------------

export async function analyzePdf(bytes: Uint8Array): Promise<{ findings: Finding[]; notes: string[] }> {
  const findings: Finding[] = [];
  const notes: string[] = [];
  const s = latin1(bytes);

  if (/\/Encrypt\b/.test(s.slice(0, 4096)) || /trailer[\s\S]{0,400}\/Encrypt\b/.test(s)) {
    notes.push("PDF is encrypted; reading the raw content layer may be incomplete.");
  }

  const objs = parseObjects(s);
  if (objs.size === 0) {
    notes.push("No PDF objects found — file may be corrupt or not a PDF.");
    return { findings, notes };
  }

  // Find page objects.
  const pages = [...objs.values()].filter((o) => /\/Type\s*\/Page(?![a-zA-Z])/.test(o.dict));
  const pageList = pages.length ? pages : [...objs.values()].filter((o) => /\/Contents\b/.test(o.dict));

  let pageNo = 0;
  let anyDecodable = false;
  let undecodableComposite = false;
  for (const page of pageList.slice(0, 60)) {
    pageNo++;

    // Resources / Font
    let resources = valueAfter(page.dict, "/Resources");
    const resRef = refNum(resources);
    if (resRef != null && objs.has(resRef)) resources = objs.get(resRef)!.dict;
    let fontDict = resources ? valueAfter(resources, "/Font") : null;
    const fdRef = refNum(fontDict);
    if (fdRef != null && objs.has(fdRef)) fontDict = objs.get(fdRef)!.dict;
    const fonts = fontDict ? await buildFontDecoders(s, objs, fontDict) : new Map<string, FontDecoder>();
    for (const f of fonts.values()) {
      if (f.decodable) anyDecodable = true;
      else undecodableComposite = true;
    }

    // Contents (single ref or array of refs)
    const contentsVal = valueAfter(page.dict, "/Contents") ?? "";
    const contentNums: number[] = [];
    const single = refNum(contentsVal);
    if (single != null) contentNums.push(single);
    else for (const m of contentsVal.matchAll(/(\d+)\s+\d+\s+R/g)) contentNums.push(parseInt(m[1]!, 10));

    let content = "";
    for (const cn of contentNums) {
      const co = objs.get(cn);
      if (co && co.streamStart >= 0) {
        try {
          content += latin1(await streamBytes(s, co)) + "\n";
        } catch {
          /* skip */
        }
      }
    }
    if (!content) continue;

    const { rects, spans } = interpret(tokenize(content), fonts);
    const hidden = coveredText(rects, spans);
    if (hidden) {
      findings.push({
        kind: "pdf.redaction",
        title: "Text hidden under a redaction box",
        severity: "critical",
        summary: `A filled rectangle is painted over this text, but the text itself is still in the page's content stream — selectable, copyable, and recovered here.`,
        location: `page ${pageNo}`,
        recovered: { type: "text", text: hidden },
      });
    }
  }

  if (!findings.length && undecodableComposite && !anyDecodable) {
    notes.push(
      "This PDF uses embedded subset fonts with no /ToUnicode map, so text under any boxes can't be reliably decoded. (No false guesses.)",
    );
  }

  return { findings, notes };
}

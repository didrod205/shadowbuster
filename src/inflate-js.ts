// Pure-JS DEFLATE (RFC 1951) inflate — a zero-dependency fallback for runtimes
// without `DecompressionStream('deflate-raw')` (Node < 20.12 / < 21.2). The fast
// path stays the platform DecompressionStream; this keeps the tool working on
// older Node and anywhere else, with no native or npm dependency.
//
// Faithful port of the public-domain "tinf" inflater (Jørgen Ibsen).

class Tree {
  table = new Uint16Array(16); // number of codes of each bit length
  trans = new Uint16Array(288); // code -> symbol translation
}

const lengthBits = new Uint8Array(30);
const lengthBase = new Uint16Array(30);
const distBits = new Uint8Array(30);
const distBase = new Uint16Array(30);
const clcidx = new Uint8Array([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
const sltree = new Tree();
const sdtree = new Tree();

function buildBitsBase(bits: Uint8Array, base: Uint16Array, delta: number, first: number): void {
  let i: number;
  for (i = 0; i < delta; i++) bits[i] = 0;
  for (i = 0; i < 30 - delta; i++) bits[i + delta] = Math.floor(i / delta);
  let sum = first;
  for (i = 0; i < 30; i++) {
    base[i] = sum;
    sum += 1 << bits[i]!;
  }
}

function buildFixedTrees(lt: Tree, dt: Tree): void {
  let i: number;
  for (i = 0; i < 7; i++) lt.table[i] = 0;
  lt.table[7] = 24;
  lt.table[8] = 152;
  lt.table[9] = 112;
  for (i = 0; i < 24; i++) lt.trans[i] = 256 + i;
  for (i = 0; i < 144; i++) lt.trans[24 + i] = i;
  for (i = 0; i < 8; i++) lt.trans[24 + 144 + i] = 280 + i;
  for (i = 0; i < 112; i++) lt.trans[24 + 144 + 8 + i] = 144 + i;
  for (i = 0; i < 5; i++) dt.table[i] = 0;
  dt.table[5] = 32;
  for (i = 0; i < 32; i++) dt.trans[i] = i;
}

function buildTree(t: Tree, lengths: Uint8Array, off: number, num: number): void {
  const offs = new Uint16Array(16);
  let i: number;
  for (i = 0; i < 16; i++) t.table[i] = 0;
  for (i = 0; i < num; i++) {
    const l = lengths[off + i]!;
    t.table[l] = t.table[l]! + 1;
  }
  t.table[0] = 0;
  let sum = 0;
  for (i = 0; i < 16; i++) {
    offs[i] = sum;
    sum += t.table[i]!;
  }
  for (i = 0; i < num; i++) {
    const len = lengths[off + i]!;
    if (len) t.trans[offs[len]!++] = i;
  }
}

class Stream {
  pos = 0;
  tag = 0;
  bitcount = 0;
  dest = new Uint8Array(1024);
  dlen = 0;
  ltree = new Tree();
  dtree = new Tree();
  constructor(public source: Uint8Array) {}

  put(b: number): void {
    if (this.dlen >= this.dest.length) {
      const grown = new Uint8Array(this.dest.length * 2);
      grown.set(this.dest);
      this.dest = grown;
    }
    this.dest[this.dlen++] = b;
  }
  getbit(): number {
    if (this.bitcount-- === 0) {
      // Guard against runaway loops on malformed input: never read past the end.
      if (this.pos >= this.source.length) throw new Error("unexpected end of DEFLATE stream");
      this.tag = this.source[this.pos++]!;
      this.bitcount = 7;
    }
    const bit = this.tag & 1;
    this.tag >>>= 1;
    return bit;
  }
  readBits(num: number, base: number): number {
    if (!num) return base;
    let val = 0;
    for (let mask = 1; mask < 1 << num; mask <<= 1) if (this.getbit()) val += mask;
    return val + base;
  }
  decodeSymbol(t: Tree): number {
    let sum = 0;
    let cur = 0;
    let len = 0;
    do {
      cur = 2 * cur + this.getbit();
      len++;
      sum += t.table[len]!;
      cur -= t.table[len]!;
    } while (cur >= 0);
    return t.trans[sum + cur]!;
  }
}

function decodeTrees(d: Stream, lt: Tree, dt: Tree): void {
  const lengths = new Uint8Array(288 + 32);
  const hlit = d.readBits(5, 257);
  const hdist = d.readBits(5, 1);
  const hclen = d.readBits(4, 4);
  let i: number;
  for (i = 0; i < 19; i++) lengths[i] = 0;
  for (i = 0; i < hclen; i++) lengths[clcidx[i]!] = d.readBits(3, 0);
  const codeTree = new Tree();
  buildTree(codeTree, lengths, 0, 19);
  for (let num = 0; num < hlit + hdist; ) {
    const sym = d.decodeSymbol(codeTree);
    if (sym === 16) {
      const prev = lengths[num - 1]!;
      for (let length = d.readBits(2, 3); length; length--) lengths[num++] = prev;
    } else if (sym === 17) {
      for (let length = d.readBits(3, 3); length; length--) lengths[num++] = 0;
    } else if (sym === 18) {
      for (let length = d.readBits(7, 11); length; length--) lengths[num++] = 0;
    } else {
      lengths[num++] = sym;
    }
  }
  buildTree(lt, lengths, 0, hlit);
  buildTree(dt, lengths, hlit, hdist);
}

function inflateBlock(d: Stream, lt: Tree, dt: Tree): void {
  for (;;) {
    let sym = d.decodeSymbol(lt);
    if (sym === 256) return;
    if (sym < 256) {
      d.put(sym);
    } else {
      sym -= 257;
      const length = d.readBits(lengthBits[sym]!, lengthBase[sym]!);
      const dist = d.decodeSymbol(dt);
      const offs = d.readBits(distBits[dist]!, distBase[dist]!);
      const start = d.dlen - offs;
      for (let i = 0; i < length; i++) d.put(d.dest[start + i]!);
    }
  }
}

function inflateUncompressed(d: Stream): void {
  if (d.bitcount > 0) {
    d.bitcount = 0; // discard to byte boundary
  }
  let p = d.pos;
  const len = d.source[p]! | (d.source[p + 1]! << 8);
  p += 4; // skip LEN + NLEN
  for (let i = 0; i < len; i++) d.put(d.source[p + i]!);
  d.pos = p + len;
}

let tablesReady = false;
function ensureTables(): void {
  if (tablesReady) return;
  buildBitsBase(lengthBits, lengthBase, 4, 3);
  buildBitsBase(distBits, distBase, 2, 1);
  lengthBits[28] = 0;
  lengthBase[28] = 258;
  buildFixedTrees(sltree, sdtree);
  tablesReady = true;
}

/** Inflate raw DEFLATE bytes (no zlib header) to the original bytes. */
export function inflateRawJS(source: Uint8Array): Uint8Array {
  ensureTables();
  const d = new Stream(source);
  let bfinal: number;
  do {
    bfinal = d.getbit();
    const btype = d.readBits(2, 0);
    if (btype === 0) inflateUncompressed(d);
    else if (btype === 1) inflateBlock(d, sltree, sdtree);
    else if (btype === 2) {
      decodeTrees(d, d.ltree, d.dtree);
      inflateBlock(d, d.ltree, d.dtree);
    } else throw new Error("invalid DEFLATE block type");
  } while (!bfinal);
  return d.dest.subarray(0, d.dlen);
}

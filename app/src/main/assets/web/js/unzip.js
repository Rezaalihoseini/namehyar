// Reads a .zip (a .docx is one) without any library. DecompressionStream is not available on every
// Android System WebView this app supports, so inflate is written out here.

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function huffman(lengths) {
  const count = new Uint16Array(16);
  for (const len of lengths) count[len]++;
  count[0] = 0;
  const offsets = new Uint16Array(16);
  for (let i = 1; i < 15; i++) offsets[i + 1] = offsets[i] + count[i];
  const symbols = new Uint16Array(lengths.length);
  lengths.forEach((len, symbol) => {
    if (len) symbols[offsets[len]++] = symbol;
  });
  return { count, symbols };
}

let fixedTables = null;
function fixed() {
  if (!fixedTables) {
    const lit = new Uint8Array(288);
    lit.fill(8, 0, 144);
    lit.fill(9, 144, 256);
    lit.fill(7, 256, 280);
    lit.fill(8, 280, 288);
    fixedTables = { lit: huffman(lit), dist: huffman(new Uint8Array(30).fill(5)) };
  }
  return fixedTables;
}

export function inflate(src, size) {
  const out = new Uint8Array(size);
  let pos = 0;
  let inPos = 0;
  let bitBuf = 0;
  let bitCount = 0;

  const bits = (n) => {
    while (bitCount < n) {
      bitBuf |= src[inPos++] << bitCount;
      bitCount += 8;
    }
    const value = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCount -= n;
    return value;
  };

  const decode = (table) => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= 15; len++) {
      code |= bits(1);
      const count = table.count[len];
      if (code - count < first) return table.symbols[index + (code - first)];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error('bad deflate data');
  };

  const codes = (lit, dist) => {
    for (;;) {
      const sym = decode(lit);
      if (sym < 256) out[pos++] = sym;
      else if (sym === 256) return;
      else {
        const len = LEN_BASE[sym - 257] + bits(LEN_EXTRA[sym - 257]);
        const d = decode(dist);
        const distance = DIST_BASE[d] + bits(DIST_EXTRA[d]);
        for (let i = 0; i < len; i++, pos++) out[pos] = out[pos - distance];
      }
    }
  };

  for (let last = 0; !last;) {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitBuf = 0;
      bitCount = 0;
      const len = src[inPos] | (src[inPos + 1] << 8);
      inPos += 4;
      out.set(src.subarray(inPos, inPos + len), pos);
      inPos += len;
      pos += len;
    } else if (type === 1) {
      const t = fixed();
      codes(t.lit, t.dist);
    } else if (type === 2) {
      const nlen = bits(5) + 257;
      const ndist = bits(5) + 1;
      const ncode = bits(4) + 4;
      const codeLengths = new Uint8Array(19);
      for (let i = 0; i < ncode; i++) codeLengths[CODE_ORDER[i]] = bits(3);
      const codeTable = huffman(codeLengths);
      const lengths = new Uint8Array(nlen + ndist);
      for (let i = 0; i < nlen + ndist;) {
        const sym = decode(codeTable);
        if (sym < 16) lengths[i++] = sym;
        else {
          const prev = sym === 16 ? lengths[i - 1] : 0;
          const repeat = sym === 16 ? 3 + bits(2) : sym === 17 ? 3 + bits(3) : 11 + bits(7);
          lengths.fill(prev, i, i + repeat);
          i += repeat;
        }
      }
      codes(huffman(lengths.subarray(0, nlen)), huffman(lengths.subarray(nlen)));
    } else {
      throw new Error('bad deflate block');
    }
  }
  return out;
}

/** Returns a Map of file name to a function that gives the file's bytes when called. */
export function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error('not a zip file');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('bad zip directory');
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    files.set(name, () => {
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const data = bytes.subarray(start, start + compressed);
      if (method === 0) return data;
      if (method === 8) return inflate(data, size);
      throw new Error('unsupported zip method');
    });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

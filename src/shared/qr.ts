/**
 * Minimal QR Code encoder (ISO/IEC 18004, byte mode, versions 1-40), pure
 * TypeScript with no dependencies so it runs on the server (invoice HTML/PDF)
 * and in the browser (store-link QR). Algorithm after Project Nayuki's
 * reference implementation (MIT): Reed-Solomon over GF(256)/0x11D, standard
 * block interleaving, all eight masks scored with the standard penalty rules.
 */

export type Ecc = 'L' | 'M' | 'Q' | 'H';
const ECC_INDEX: Record<Ecc, number> = { L: 0, M: 1, Q: 2, H: 3 };
const FORMAT_BITS: Record<Ecc, number> = { L: 1, M: 0, Q: 3, H: 2 };

const ECC_CODEWORDS_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_ERROR_CORRECTION_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

const getBit = (x: number, i: number) => ((x >>> i) & 1) !== 0;

function numRawDataModules(ver: number) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

function numDataCodewords(ver: number, ecc: Ecc) {
  const e = ECC_INDEX[ecc];
  return Math.floor(numRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[e]![ver]! * NUM_ERROR_CORRECTION_BLOCKS[e]![ver]!;
}

function gfMul(x: number, y: number) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number) {
  const result: number[] = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j]!, root);
      if (j + 1 < result.length) result[j]! ^= result[j + 1]!;
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]) {
  const result: number[] = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    divisor.forEach((coef, i) => { result[i]! ^= gfMul(coef, factor); });
  }
  return result;
}

function utf8Bytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

export type QrMatrix = { size: number; version: number; ecc: Ecc; mask: number; modules: boolean[][] };

/** Encodes text (UTF-8, byte mode) at the smallest version that fits. `mask` forces a mask (tests). */
export function encodeQr(text: string, opts: { ecc?: Ecc; mask?: number; minVersion?: number } = {}): QrMatrix {
  const ecc = opts.ecc ?? 'M';
  const data = utf8Bytes(text);
  let version = Math.max(1, opts.minVersion ?? 1);
  for (; ; version++) {
    if (version > 40) throw new Error('qr_data_too_long');
    const countBits = version < 10 ? 8 : 16;
    if (4 + countBits + data.length * 8 <= numDataCodewords(version, ecc) * 8 && data.length < 2 ** countBits) break;
  }
  const countBits = version < 10 ? 8 : 16;
  const bits: number[] = [];
  const push = (val: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(0b0100, 4);
  push(data.length, countBits);
  for (const b of data) push(b, 8);
  const capacity = numDataCodewords(version, ecc) * 8;
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) codewords.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

  // Error correction + interleaving.
  const e = ECC_INDEX[ecc];
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[e]![version]!;
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[e]![version]!;
  const rawCodewords = Math.floor(numRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(blockEccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = codewords.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const eccBytes = rsRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(eccBytes));
  }
  const all: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((block, j) => { if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) all.push(block[i]!); });
  }

  const size = version * 4 + 17;
  const modules: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const isFn: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const setFn = (x: number, y: number, dark: boolean) => { modules[y]![x] = dark; isFn[y]![x] = true; };

  // Function patterns.
  for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
  const finder = (x: number, y: number) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy)), xx = x + dx, yy = y + dy;
      if (xx >= 0 && xx < size && yy >= 0 && yy < size) setFn(xx, yy, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const align: number[] = [];
  if (version > 1) {
    const numAlign = Math.floor(version / 7) + 2;
    const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
    align.push(6);
    for (let pos = size - 7; align.length < numAlign; pos -= step) align.splice(1, 0, pos);
  }
  const na = align.length;
  for (let i = 0; i < na; i++) for (let j = 0; j < na; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === na - 1) || (i === na - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFn(align[i]! + dx, align[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const drawFormat = (mask: number) => {
    const d = (FORMAT_BITS[ecc] << 3) | mask;
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const b = ((d << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) setFn(8, i, getBit(b, i));
    setFn(8, 7, getBit(b, 6)); setFn(8, 8, getBit(b, 7)); setFn(7, 8, getBit(b, 8));
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, getBit(b, i));
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, getBit(b, i));
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, getBit(b, i));
    setFn(8, size - 8, true);
  };
  drawFormat(0);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const b = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const c = getBit(b, i), a = size - 11 + (i % 3), bb = Math.floor(i / 3);
      setFn(a, bb, c); setFn(bb, a, c);
    }
  }

  // Data modules (zig-zag).
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j;
      const upward = ((right + 1) & 2) === 0;
      const y = upward ? size - 1 - vert : vert;
      if (!isFn[y]![x] && i < all.length * 8) { modules[y]![x] = getBit(all[i >>> 3]!, 7 - (i & 7)); i++; }
    }
  }

  const applyMask = (mask: number) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (isFn[y]![x]) continue;
      let inv: boolean;
      switch (mask) {
        case 0: inv = (x + y) % 2 === 0; break;
        case 1: inv = y % 2 === 0; break;
        case 2: inv = x % 3 === 0; break;
        case 3: inv = (x + y) % 3 === 0; break;
        case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: inv = ((x * y) % 2) + ((x * y) % 3) === 0; break;
        case 6: inv = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        default: inv = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
      }
      if (inv) modules[y]![x] = !modules[y]![x];
    }
  };

  const penalty = () => {
    let result = 0;
    const addHistory = (len: number, h: number[]) => { if (h[0] === 0) len += size; h.pop(); h.unshift(len); };
    const countPatterns = (h: number[]) => {
      const n = h[1]!;
      const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
      return (core && h[0]! >= n * 4 && h[6]! >= n ? 1 : 0) + (core && h[6]! >= n * 4 && h[0]! >= n ? 1 : 0);
    };
    const terminate = (color: boolean, len: number, h: number[]) => {
      if (color) { addHistory(len, h); len = 0; }
      len += size; addHistory(len, h);
      return countPatterns(h);
    };
    for (const horizontal of [true, false]) {
      for (let a = 0; a < size; a++) {
        let runColor = false, run = 0;
        const h = [0, 0, 0, 0, 0, 0, 0];
        for (let b = 0; b < size; b++) {
          const c = horizontal ? modules[a]![b]! : modules[b]![a]!;
          if (c === runColor) { run++; if (run === 5) result += 3; else if (run > 5) result++; }
          else { addHistory(run, h); if (!runColor) result += countPatterns(h) * 40; runColor = c; run = 1; }
        }
        result += terminate(runColor, run, h) * 40;
      }
    }
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
      const c = modules[y]![x];
      if (c === modules[y]![x + 1] && c === modules[y + 1]![x] && c === modules[y + 1]![x + 1]) result += 3;
    }
    let dark = 0;
    for (const row of modules) for (const c of row) if (c) dark++;
    const total = size * size;
    result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return result;
  };

  let mask = opts.mask ?? -1;
  if (mask < 0) {
    let best = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(m); drawFormat(m);
      const p = penalty();
      if (p < best) { best = p; mask = m; }
      applyMask(m);
    }
  }
  applyMask(mask);
  drawFormat(mask);
  return { size, version, ecc, mask, modules };
}

/** Run-length SVG path of the dark modules (one subpath per horizontal run). */
export function qrPath(m: QrMatrix, margin: number) {
  let d = '';
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (!m.modules[y]![x]) continue;
      let w = 1;
      while (x + w < m.size && m.modules[y]![x + w]) w++;
      d += `M${x + margin} ${y + margin}h${w}v1h-${w}z`;
      x += w - 1;
    }
  }
  return d;
}

/**
 * Standalone SVG. `logo` (an image href) is drawn on a white plate in the
 * centre; callers using a logo should encode with ecc 'H' (or 'Q').
 */
export function qrSvg(m: QrMatrix, opts: { margin?: number; dark?: string; light?: string; logo?: string | null; logoScale?: number; title?: string } = {}) {
  const margin = opts.margin ?? 4;
  const dim = m.size + margin * 2;
  const dark = opts.dark ?? '#000000';
  const light = opts.light ?? '#ffffff';
  let logo = '';
  if (opts.logo) {
    const s = dim * (opts.logoScale ?? 0.22);
    const pad = s * 0.12;
    const o = (dim - s) / 2;
    logo = `<rect x="${(o - pad).toFixed(2)}" y="${(o - pad).toFixed(2)}" width="${(s + pad * 2).toFixed(2)}" height="${(s + pad * 2).toFixed(2)}" rx="${(pad * 1.5).toFixed(2)}" fill="${light}"/>`
      + `<image href="${escapeAttr(opts.logo)}" x="${o.toFixed(2)}" y="${o.toFixed(2)}" width="${s.toFixed(2)}" height="${s.toFixed(2)}" preserveAspectRatio="xMidYMid meet"/>`;
  }
  const title = opts.title ? `<title>${escapeAttr(opts.title)}</title>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img">${title}<rect width="${dim}" height="${dim}" fill="${light}"/><path d="${qrPath(m, margin)}" fill="${dark}"/>${logo}</svg>`;
}

function escapeAttr(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

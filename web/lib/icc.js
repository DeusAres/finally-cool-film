// Display P3 / sRGB ICC profiles (v2, the most widely read version), built in code, and
// their JPEG APP2 segment. When the photo is Display P3 (every iPhone photo) the
// engine renders straight into P3, which keeps the saturated reds / oranges /
// yellows sRGB would have to squeeze; the JPEG must then say it is P3. An sRGB
// export says so too, rather than leaving the viewer to assume it.
//
// Contents: D50 PCS; media white D50 with a `chad` tag holding the D65→D50
// Bradford matrix; the primaries (color.js) Bradford-adapted to D50, as ICC
// requires; the sRGB transfer curve (shared by sRGB and P3) as a 1024-entry
// `curv`, shared by the three channels.

import { srgbToLinear, RGB_TO_XYZ, inv3 } from './color.js';

const PROFILES = { srgb: 'sRGB', p3: 'Display P3' };
const D65 = [0.95047, 1.0, 1.08883], D50 = [0.96422, 1.0, 0.82521];
const BRADFORD = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]];

const mul = (A, B) => A.map((r) => B[0].map((_, j) => r.reduce((s, v, k) => s + v * B[k][j], 0)));
const mulv = (A, v) => A.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);

/** D65 → D50 Bradford adaptation matrix. */
function chad() {
  const s = mulv(BRADFORD, D65), d = mulv(BRADFORD, D50);
  const scale = [[d[0] / s[0], 0, 0], [0, d[1] / s[1], 0], [0, 0, d[2] / s[2]]];
  return mul(inv3(BRADFORD), mul(scale, BRADFORD));
}

const cache = {};

/** The ICC profile bytes of `space` ('srgb' | 'p3'). */
function profile(space) {
  if (cache[space]) return cache[space];
  const C = chad(), M = mul(C, RGB_TO_XYZ[space]);      // colorants, D50-adapted
  const col = (j) => [M[0][j], M[1][j], M[2][j]];

  const enc = (s) => Array.from(s, (ch) => ch.charCodeAt(0));
  const u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const s15 = (v) => u32(Math.round(v * 65536) >>> 0);
  const pad4 = (a) => { while (a.length % 4) a.push(0); return a; };
  const xyz = (v) => [...enc('XYZ '), 0, 0, 0, 0, ...s15(v[0]), ...s15(v[1]), ...s15(v[2])];
  const desc = (t) => {
    const a = [...enc('desc'), 0, 0, 0, 0, ...u32(t.length + 1), ...enc(t), 0];
    a.push(0, 0, 0, 0, 0, 0, 0, 0);                     // unicode: language, count 0
    a.push(0, 0, 0, ...new Array(67).fill(0));          // scriptcode: code, count 0, 67 bytes
    return a;
  };
  const text = (t) => [...enc('text'), 0, 0, 0, 0, ...enc(t), 0];
  const sf32 = (m) => [...enc('sf32'), 0, 0, 0, 0, ...m.flat().flatMap(s15)];
  const curv = () => {
    const n = 1024, a = [...enc('curv'), 0, 0, 0, 0, ...u32(n)];
    for (let i = 0; i < n; i++) {
      const v = Math.round(srgbToLinear(i / (n - 1)) * 65535);
      a.push(v >> 8, v & 255);
    }
    return a;
  };

  const trc = pad4(curv());
  const tags = [
    ['desc', pad4(desc(PROFILES[space]))],
    ['cprt', pad4(text('No copyright, use freely'))],
    ['wtpt', xyz(D50)],
    ['chad', sf32(C)],
    ['rXYZ', xyz(col(0))], ['gXYZ', xyz(col(1))], ['bXYZ', xyz(col(2))],
    ['rTRC', trc], ['gTRC', trc], ['bTRC', trc],         // same data, written once
  ];
  const tableSize = 4 + 12 * tags.length;
  let offset = 128 + tableSize;
  const table = [...u32(tags.length)], data = [], seen = new Map();
  for (const [sig, bytes] of tags) {
    let at = seen.get(bytes);
    if (at === undefined) { at = offset; seen.set(bytes, at); data.push(...bytes); offset += bytes.length; }
    table.push(...enc(sig), ...u32(at), ...u32(bytes.length));
  }
  const size = 128 + tableSize + data.length;
  const header = [
    ...u32(size), 0, 0, 0, 0, 2, 0x10, 0, 0, ...enc('mntr'), ...enc('RGB '), ...enc('XYZ '),
    0x07, 0xea, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0,            // 2026-01-01
    ...enc('acsp'), ...enc('APPL'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,                  // attributes, rendering intent
    ...s15(D50[0]), ...s15(D50[1]), ...s15(D50[2]), 0, 0, 0, 0,
  ];
  while (header.length < 128) header.push(0);
  return (cache[space] = new Uint8Array([...header, ...table, ...data]));
}

/** The profile of `space` ('srgb' | 'p3') as a JPEG APP2 ICC_PROFILE segment (FFE2 + length + payload). */
export function iccSegment(space) {
  const prof = profile(space);
  const len = 2 + 14 + prof.length;
  const seg = new Uint8Array(2 + len);
  seg.set([0xff, 0xe2, len >> 8, len & 255], 0);
  seg.set([...'ICC_PROFILE'].map((c) => c.charCodeAt(0)), 4);
  seg.set([0, 1, 1], 15);                               // NUL, sequence 1 of 1
  seg.set(prof, 18);
  return seg;
}

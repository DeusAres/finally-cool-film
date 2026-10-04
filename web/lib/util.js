// Small helpers shared by the app, the debug log and the bench page.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** localStorage that never throws (private mode, quota, disabled): reads give null, writes are dropped. `set(k, null)` removes. */
export const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

/** Long side of the 36 mm film frame, µm: every spatial effect (grain, dust, clarity, lens) is defined on it, never in px. */
export const FRAME_UM = 36000;

// WGSL literals for shaders assembled in JS: a float always has its point.
export const wf = (n) => (Number.isInteger(n) ? n.toFixed(1) : String(n));
export const wv3 = (a) => `vec3<f32>(${a.map(wf).join(', ')})`;
/** mat3x3 from 9 row-major numbers; WGSL columns = rows of `m`, as `v * M` wants. */
export const wm3 = (m) => `mat3x3<f32>(${[0, 3, 6].map((i) => wv3(m.slice(i, i + 3))).join(', ')})`;

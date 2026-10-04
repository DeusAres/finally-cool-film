// Small helpers shared by the app, the debug log and the bench page.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** localStorage that never throws (private mode, quota, disabled): reads give null, writes are dropped. `set(k, null)` removes. */
export const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

/** Long side of the 36 mm film frame, µm: every spatial effect (grain, dust, clarity, lens) is defined on it, never in px. */
export const FRAME_UM = 36000;

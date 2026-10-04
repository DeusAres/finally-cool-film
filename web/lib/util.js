// Small helpers shared by the app, the debug log and the bench page.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** localStorage that never throws (private mode, quota, disabled): reads give null, writes are dropped. `set(k, null)` removes. */
export const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

// Crash-survivable log: every line is written through to localStorage, so if
// iOS kills the tab (out of memory: no JS event fires, nothing can be caught)
// the trail up to that instant is readable on the next load. A "busy" marker
// set around risky work (each render, the export) tells the next load that
// the previous session died in the middle of it. Each load starts a fresh log
// and keeps the previous session's as `prevLogText`.
const KEY = 'fcf_log', PREV = 'fcf_log_prev', BUSY = 'fcf_busy', MAX_LINES = 300;

const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };

const prev = read(KEY) || '';
write(PREV, prev);
write(KEY, null);
let lines = [];

export function log(msg) {
  const line = `${new Date().toISOString().slice(11, 23)} ${msg}`;
  lines.push(line);
  if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
  write(KEY, lines.join('\n'));
  console.log(line);
}

export const logText = () => lines.join('\n');
export const prevLogText = () => prev;

/** Mark risky work in progress (e.g. 'export'); pass null when it finished. */
export const setBusy = (what) => write(BUSY, what);

/** What the previous session was doing when it died, or null if it ended cleanly. */
export function takeCrashMarker() {
  const what = read(BUSY);
  write(BUSY, null);
  return what;
}

window.addEventListener('error', (e) => log(`[error] ${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => log(`[unhandled] ${e.reason?.stack || e.reason}`));
if (navigator.deviceMemory) log(`deviceMemory ${navigator.deviceMemory} GB`);

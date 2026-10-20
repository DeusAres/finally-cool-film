// Crash-survivable log: every line is written through to localStorage, so if
// iOS kills the tab (out of memory: no JS event fires, nothing can be caught)
// the trail up to that instant is readable on the next load. A "busy" marker
// set around risky work (each render, a photo decode, the export) tells the next load that
// the previous session died in the middle of it. Each load starts a fresh log
// and keeps the previous session's as `prevLogText`.
import { store } from './util.js';

const KEY = 'fcf_log', PREV = 'fcf_log_prev', BUSY = 'fcf_busy', MAX_LINES = 300;

const { get: read, set: write } = store;

const prev = read(KEY) || '';
write(PREV, prev);
write(KEY, null);
let lines = [];

// The buffer (~30 KB) is persisted at most every PERSIST_MS, not on every line (a slider drag logs per render, and each
// localStorage write is synchronous): a crash loses at most that much of the log; pagehide flushes it.
const PERSIST_MS = 200;
let persistTimer = 0;
const persist = () => { persistTimer = 0; write(KEY, lines.join('\n')); };
// pagehide, and hidden: iOS often kills a backgrounded tab without a pagehide.
const flushLog = () => { if (persistTimer) { clearTimeout(persistTimer); persist(); } };
addEventListener('pagehide', flushLog);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushLog(); });
export function log(msg) {
  const line = `${new Date().toISOString().slice(11, 23)} ${msg}`;
  lines.push(line);
  if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
  if (!persistTimer) persistTimer = setTimeout(persist, PERSIST_MS);
  console.log(line);
}

export const logText = () => lines.join('\n');
export const prevLogText = () => prev;

/** Mark risky work in progress (e.g. 'export'); pass null when it finished. `flush`: also persist the log now (a decode or
 * an export, so the lines leading up to a crash survive the persist throttle; not per render, that would undo it). */
export const setBusy = (what, flush = false) => {
  write(BUSY, what);
  if (flush) flushLog();
};

/** What the previous session was doing when it died, or null if it ended cleanly. */
export function takeCrashMarker() {
  const what = read(BUSY);
  write(BUSY, null);
  return what;
}

window.addEventListener('error', (e) => log(`[error] ${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => log(`[unhandled] ${e.reason?.stack || e.reason}`));
if (navigator.deviceMemory) log(`deviceMemory ${navigator.deviceMemory} GB`);

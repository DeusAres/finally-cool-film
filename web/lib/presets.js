// Presets (user, 2026-11-26): a saved look, made of every tool of the Scanner and Effetti groups (the scanner and its keys,
// Hyper Tone, the lens, texture...). Base (exposure, light, vividness, grain, halation: the photo and the film) and Trasforma
// (tilt, crop, border, frame) stay out: they belong to the photo, not to the look. Kept in this browser (localStorage),
// newest first; a name saved again replaces the old one. No DOM: the UI is lib/ui2.js.
import { store } from './util.js';

const KEY = 'fcf_presets';

/** The saved presets: [{ name, scanner, v: { inputId: value } }], newest first. A broken store reads as none. */
export function loadPresets() {
  try {
    const a = JSON.parse(store.get(KEY) || '[]');
    return Array.isArray(a) ? a.filter((p) => p && typeof p.name === 'string' && p.v && typeof p.v === 'object') : [];
  } catch { return []; }
}

/** Save `preset` under its name (trimmed), replacing one of the same name; returns the new list. */
export function savePreset(preset) {
  const name = preset.name.trim();
  const list = [{ ...preset, name }, ...loadPresets().filter((p) => p.name !== name)];
  store.set(KEY, JSON.stringify(list));
  return list;
}

/** Delete the preset called `name`; returns the new list. */
export function deletePreset(name) {
  const list = loadPresets().filter((p) => p.name !== name);
  store.set(KEY, JSON.stringify(list));
  return list;
}

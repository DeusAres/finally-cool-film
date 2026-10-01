const { displayTone } = await import('/home/user/finally-cool-film/web/lib/tone.js');
const L = (y) => (y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y);
const ins = [0.01, 0.05, 0.18, 0.35, 0.5, 0.7, 0.85, 1.0];
console.log('input L*      ', ins.map(d => L(d).toFixed(0).padStart(4)).join(''));
for (const [ev, r] of [[0, 0], [0, 0.6], [0, 1], [1, 0.6], [2, 0.6], [2.5, 0.6], [-1, 0.6]]) {
  const f = displayTone(ev, r); const ys = ins.map(f);
  let mono = true; let prev = -1; for (let d = 0.0005; d <= 1; d += 0.0005) { const y = f(d); if (y < prev - 1e-9) mono = false; prev = y; }
  console.log(`ev ${String(ev).padStart(4)} roll ${r}`, ys.map(y => L(y).toFixed(0).padStart(4)).join(''), mono ? '' : 'NOT MONOTONE');
}

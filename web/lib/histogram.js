// The preview's histogram (from app.js, 4.45).
// RGB + luminance of what is on screen, from the 8-bit display pixels (every
// other pixel in both directions is plenty). Square-root scale against the
// tallest bin that is not a clipped end: a dark or sky-heavy frame keeps a
// readable shape instead of one spike and a flat line. `r`: only that region's pixels (app.js: the crop box while it is drawn).
const HBINS = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
export function drawHistogram(histo, img, r = null) {
  const hctx = histo.getContext('2d');
  const bins = HBINS;
  for (const b of bins) b.fill(0);
  const { data, width } = img;
  r ??= { ox: 0, oy: 0, w: img.width, h: img.height };
  for (let y = r.oy; y < r.oy + r.h; y += 2) {
    for (let i = (y * width + r.ox) * 4, end = i + r.w * 4; i < end; i += 8) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      bins[0][r]++; bins[1][g]++; bins[2][b]++;
      bins[3][(r * 54 + g * 183 + b * 19) >> 8]++;
    }
  }
  let max = 1;
  for (const h of bins) for (let v = 1; v < 255; v++) max = Math.max(max, h[v]);
  max = Math.sqrt(max);
  const W = histo.width, H = histo.height;
  hctx.clearRect(0, 0, W, H);
  const area = (h, style, op) => {
    hctx.globalCompositeOperation = op;
    hctx.fillStyle = style;
    hctx.beginPath(); hctx.moveTo(0, H);
    for (let v = 0; v < 256; v++) hctx.lineTo(v * W / 255, H - Math.min(1, Math.sqrt(h[v]) / max) * (H - 2));
    hctx.lineTo(W, H); hctx.closePath(); hctx.fill();
  };
  area(bins[3], 'rgba(200,200,200,0.35)', 'source-over');
  area(bins[0], 'rgba(255,60,60,0.55)', 'lighter');
  area(bins[1], 'rgba(60,255,60,0.55)', 'lighter');
  area(bins[2], 'rgba(70,110,255,0.6)', 'lighter');
  hctx.globalCompositeOperation = 'source-over';
  histo.style.display = 'block';
}

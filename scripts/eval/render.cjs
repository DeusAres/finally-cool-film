// Usage: node scripts/eval/render.cjs <baseUrl> <photoPath> <outPng> [slidersJSON]
// Loads a photo (DNG / ORF / JPEG) into the film app in headless Chromium (WebGPU on SwiftShader), sets sliders, waits for the
// render, saves the native-size #view canvas as PNG. Used by scripts/eval/check.py.
//
// "Render finished" signal: render() in app.js ends with status(`${w}×${h} · N ms (render R · display D)`)
// right after ctx.putImageData. A MutationObserver installed before page scripts counts every #status
// update matching "(render ", so each completed render pass (including do/while dirty re-passes) is counted.
// Done = counter advanced past its pre-change value AND stayed unchanged for SETTLE ms (a dirty re-pass
// starts synchronously, so any gap means the loop ended). Initial load additionally requires #export enabled
// (set at the very end of loadPhoto, after runAuto awaited the first render).
//
// PNG pixels = raw bytes of the app's canvas (getImageData colorSpace 'display-p3', no conversion),
// tagged with a cICP chunk (Display P3 primaries, sRGB transfer, full range). Dust overlay is a separate canvas.
const { chromium } = (() => {
  for (const m of ['playwright', '/opt/node-tools/node_modules/playwright']) { try { return require(m); } catch (e) { /* next */ } }
  throw new Error('playwright not found (npm i -g playwright, or set NODE_PATH)');
})();
const fs = require('fs'), zlib = require('zlib');
const [baseUrl, dng, outPng, slidersArg] = process.argv.slice(2);
const SETTLE = 1500, TIMEOUT = 1800000;
// Chromium: $FCF_CHROME, else the newest /opt/pw-browsers/chromium-*/chrome-linux/chrome, else Playwright's own.
function chromePath() {
  if (process.env.FCF_CHROME) return process.env.FCF_CHROME;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  try {
    const dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => +b.split('-')[1] - +a.split('-')[1]);
    for (const d of dirs) { const p = `${root}/${d}/chrome-linux/chrome`; if (fs.existsSync(p)) return p; }
  } catch (e) { /* none */ }
  return undefined;
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(w, h, rgba) {
  const stride = w * 4, raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('cICP', Buffer.from([12, 13, 0, 1])), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

(async () => {
  let browser, beat;
  try {
    if (!baseUrl || !dng || !outPng) throw new Error('usage: node app.cjs <baseUrl> <dngPath> <outPng> [slidersJSON]');
    if (!fs.existsSync(dng)) throw new Error('dng not found: ' + dng);
    const sliders = slidersArg ? JSON.parse(slidersArg) : {};
    browser = await chromium.launch({
      executablePath: chromePath(), headless: true,
      args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader'],
    });
    const page = await browser.newPage({ viewport: { width: 1000, height: 1000 }, acceptDownloads: true });
    page.setDefaultTimeout(TIMEOUT);
    // Watchdog: every BEAT s print the app's #status (progress: "tile 12/20…"); if it has not changed for STALL s the run is
    // stuck (lost GPU device, hung WebGPU on SwiftShader): close the browser and fail fast instead of waiting for TIMEOUT.
    const BEAT = +(process.env.FCF_BEAT_S || 15), STALL = +(process.env.FCF_STALL_S || 180), t0 = Date.now();
    let lastSt = null, lastChange = Date.now();
    beat = setInterval(async () => {
      let st = '?';
      try { st = (await page.textContent('#status', { timeout: 5000 })) || ''; } catch (e) { /* page busy */ }
      if (st !== lastSt) { lastSt = st; lastChange = Date.now(); }
      console.error(`[beat ${Math.round((Date.now() - t0) / 1000)}s] ${st}`);
      if (Date.now() - lastChange > STALL * 1000) {
        console.log(`ERR stalled: status unchanged for ${STALL} s: ${st}`);
        clearInterval(beat);
        try { await browser.close(); } catch (e) { /* gone */ }
        process.exit(2);
      }
    }, BEAT * 1000);
    page.on('console', (m) => { if (m.type() === 'error') console.error('[console.error]', m.text()); });
    page.on('pageerror', (e) => console.error('[pageerror]', e.message));
    await page.addInitScript(() => {
      window.__renders = 0; window.__last = '';
      const hook = () => {
        const el = document.getElementById('status');
        if (!el) return requestAnimationFrame(hook);
        new MutationObserver(() => { const t = el.textContent; if (t.includes('(render ')) { window.__renders++; window.__last = t; } })
          .observe(el, { childList: true, characterData: true, subtree: true });
      };
      hook();
    });
    const settle = async (before) => {
      // The app's render loop re-runs while sliders keep changing (dirty flag) and clears its
      // localStorage breadcrumb 'fcf_busy' only when the whole loop ends: wait for that.
      await page.waitForFunction((b) => window.__renders > b && localStorage.getItem('fcf_busy') === null, before, { timeout: TIMEOUT, polling: 100 });
      for (;;) {
        const n = await page.evaluate(() => window.__renders);
        await page.waitForTimeout(SETTLE);
        if (n === await page.evaluate(() => window.__renders)) return;
      }
    };
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => /^Pronto|WebGPU non disponibile|Errore/.test(document.getElementById('status').textContent), null, { timeout: TIMEOUT });
    if (!/^Pronto/.test(await page.textContent('#status'))) throw new Error('engine boot: ' + await page.textContent('#status'));
    await page.setInputFiles('#pick', dng);
    await page.waitForFunction(() => {
      const t = document.getElementById('status').textContent;
      return /^Errore/.test(t) || (!document.getElementById('export').disabled && window.__renders > 0);
    }, null, { timeout: TIMEOUT, polling: 200 });
    const st = await page.textContent('#status');
    if (/^Errore/.test(st)) throw new Error(st);
    await settle(0);

    const before = await page.evaluate(() => window.__renders);
    // special keys: _click: [button ids] clicked in order (each settles); _export: path to save the exported JPEG
    const clicks = sliders._click || [], exportTo = sliders._export, exportBtn = sliders._exportBtn || 'export';
    delete sliders._click; delete sliders._export; delete sliders._exportBtn;
    const wantRender = Object.keys(sliders).some((k) => !['dust', 'quality', 'border'].includes(k));   // these never trigger a render: waiting for one hung
    const all = { ...sliders, dust: 0 };   // dust is an overlay layer, never in the canvas; zero it anyway
    await page.evaluate((s) => {
      for (const [id, v] of Object.entries(s)) {
        const el = document.getElementById(id);
        if (!el) throw new Error('no slider #' + id);
        if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, all);
    if (wantRender) await settle(before);
    for (const id of clicks) {
      const b = await page.evaluate(() => window.__renders);
      await page.evaluate((i) => document.getElementById(i).click(), id);
      await settle(b);
    }
    if (exportTo) {
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 1800000 }), page.evaluate((b) => document.getElementById(b).click(), exportBtn)]);
      await dl.saveAs(exportTo);
      console.error('export saved', exportTo, await page.textContent('#status'));
    }

    const r = await page.evaluate(() => {
      const c = document.getElementById('view'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height, { colorSpace: 'display-p3' }).data;
      let s = ''; for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode.apply(null, d.subarray(i, i + 0x8000));
      return { w: c.width, h: c.height, b64: btoa(s), last: window.__last };
    });
    fs.writeFileSync(outPng, encodePng(r.w, r.h, Buffer.from(r.b64, 'base64')));
    const m = /(\d+) ms \(render/.exec(r.last);
    console.log(`OK ${r.w}x${r.h} ${m ? m[1] : '?'}`);
  } catch (e) {
    console.log('ERR ' + (e && e.message || e));
    process.exitCode = 1;
  } finally { clearInterval(beat); if (browser) await browser.close(); }
})();

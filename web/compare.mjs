// Before/after composites and pixel diffs, done on a canvas inside the browser (no image library).
import fs from 'node:fs/promises';
import path from 'node:path';

const ORIGIN = 'http://lens.compare';

async function inPage({ beforeUrl, afterUrl, labels, scale, threshold, layout, highlight, wantDiff }) {
  const MAX_SIDE = 16384;
  const MAX_AREA = 200e6;
  const load = async (url) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  };
  const toBase64 = (canvas) => new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error('canvas export failed'));
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result.slice(fr.result.indexOf(',') + 1));
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    }, 'image/png');
  });
  const [before, after] = await Promise.all([load(beforeUrl), load(afterUrl)]);
  const bw = before.naturalWidth, bh = before.naturalHeight, aw = after.naturalWidth, ah = after.naturalHeight;
  const W = Math.max(bw, aw), H = Math.max(bh, ah);

  // Diff in strips so pages taller than the canvas limit still work.
  const STRIP = 1024;
  const mk = () => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = STRIP;
    return [c, c.getContext('2d', { willReadFrequently: true })];
  };
  const [, ctxA] = mk();
  const [, ctxB] = mk();
  const diffFits = wantDiff && W <= MAX_SIDE && H <= MAX_SIDE && W * H <= MAX_AREA;
  let diffCanvas = null, diffCtx = null;
  if (diffFits) {
    diffCanvas = document.createElement('canvas');
    diffCanvas.width = W;
    diffCanvas.height = H;
    diffCtx = diffCanvas.getContext('2d');
  }
  let changed = 0, minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y0 = 0; y0 < H; y0 += STRIP) {
    const h = Math.min(STRIP, H - y0);
    ctxA.clearRect(0, 0, W, STRIP);
    ctxB.clearRect(0, 0, W, STRIP);
    if (y0 < bh) ctxA.drawImage(before, 0, y0, bw, Math.min(h, bh - y0), 0, 0, bw, Math.min(h, bh - y0));
    if (y0 < ah) ctxB.drawImage(after, 0, y0, aw, Math.min(h, ah - y0), 0, 0, aw, Math.min(h, ah - y0));
    const a = ctxA.getImageData(0, 0, W, h).data;
    const bImg = ctxB.getImageData(0, 0, W, h);
    const b = bImg.data;
    for (let y = 0; y < h; y++) {
      const py = y0 + y;
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const outside = (x >= bw || py >= bh) !== (x >= aw || py >= ah);
        const differs = outside
          || Math.abs(a[i] - b[i]) > threshold || Math.abs(a[i + 1] - b[i + 1]) > threshold
          || Math.abs(a[i + 2] - b[i + 2]) > threshold || Math.abs(a[i + 3] - b[i + 3]) > threshold;
        if (differs) {
          changed++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (py < minY) minY = py;
          if (py > maxY) maxY = py;
        }
        if (diffCtx) {
          if (differs) {
            b[i] = 255; b[i + 1] = 0; b[i + 2] = 200; b[i + 3] = 255;
          } else {
            // Fade unchanged pixels towards white so the changed ones stand out.
            b[i] = 255 - ((255 - b[i]) >> 2); b[i + 1] = 255 - ((255 - b[i + 1]) >> 2);
            b[i + 2] = 255 - ((255 - b[i + 2]) >> 2); b[i + 3] = 255;
          }
        }
      }
    }
    if (diffCtx) diffCtx.putImageData(bImg, 0, y0);
  }
  const bbox = changed ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null;

  const pad = 16 * scale, labelH = 36 * scale, gap = 16 * scale;
  const row = layout === 'row';
  const cw = row ? pad * 2 + bw + gap + aw : pad * 2 + W;
  const ch = row ? pad * 2 + labelH + H : pad * 2 + labelH * 2 + gap + bh + ah;
  const k = Math.min(1, MAX_SIDE / cw, MAX_SIDE / ch, Math.sqrt(MAX_AREA / (cw * ch)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(cw * k);
  canvas.height = Math.floor(ch * k);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f6f8fa';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(k, k);
  ctx.font = `600 ${16 * scale}px "DejaVu Sans", "Liberation Sans", Arial, sans-serif`;
  ctx.textBaseline = 'middle';
  const place = (img, label, x, y) => {
    ctx.fillStyle = '#1f2328';
    ctx.fillText(label, x, y + labelH / 2);
    const iy = y + labelH;
    ctx.drawImage(img, x, iy);
    ctx.lineWidth = scale;
    ctx.strokeStyle = '#d0d7de';
    ctx.strokeRect(x - scale / 2, iy - scale / 2, img.naturalWidth + scale, img.naturalHeight + scale);
    if (highlight && bbox) {
      ctx.lineWidth = 2 * scale;
      ctx.strokeStyle = '#d1242f';
      const o = 2 * scale;
      ctx.strokeRect(x + bbox.x - o, iy + bbox.y - o, bbox.width + 2 * o, bbox.height + 2 * o);
    }
  };
  place(before, labels[0], pad, pad);
  if (row) place(after, labels[1], pad + bw + gap, pad);
  else place(after, labels[1], pad, pad + labelH + bh + gap);

  return {
    before: { width: bw, height: bh },
    after: { width: aw, height: ah },
    changedPixels: changed,
    totalPixels: W * H,
    bbox,
    compositeSize: { width: canvas.width, height: canvas.height },
    compositeScaledDown: k < 1,
    composite: await toBase64(canvas),
    diff: diffCtx ? await toBase64(diffCanvas) : null,
  };
}

export async function runCompare(browser, job) {
  const page = await browser.newPage();
  await page.route(`${ORIGIN}/**`, async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>compare</title>' });
    const [, side, name] = /^\/(before|after)\/([^/]+)$/.exec(decodeURIComponent(p)) ?? [];
    if (!name || name === '..') return route.abort();
    const file = path.join(side === 'before' ? job.beforeDir : job.afterDir, name);
    return route.fulfill({ contentType: 'image/png', body: await fs.readFile(file) });
  });
  await page.goto(`${ORIGIN}/`);
  const pairs = [];
  for (const pair of job.pairs) {
    const entry = { name: pair.name, before: pair.before, after: pair.after };
    try {
      const r = await page.evaluate(inPage, {
        beforeUrl: `${ORIGIN}/before/${encodeURIComponent(pair.before)}`,
        afterUrl: `${ORIGIN}/after/${encodeURIComponent(pair.after)}`,
        labels: job.labels,
        scale: pair.scale,
        threshold: job.threshold,
        layout: job.layout,
        highlight: job.highlight,
        wantDiff: job.diff,
      });
      const { composite, diff, ...numbers } = r;
      Object.assign(entry, numbers);
      entry.sizeChanged = r.before.width !== r.after.width || r.before.height !== r.after.height;
      entry.changedPercent = Math.round((r.changedPixels / r.totalPixels) * 1e6) / 1e4;
      entry.identical = r.changedPixels === 0;
      entry.file = `${pair.name}.compare.png`;
      await fs.writeFile(path.join(job.outDir, entry.file), Buffer.from(composite, 'base64'));
      if (diff) {
        entry.diffFile = `${pair.name}.diff.png`;
        await fs.writeFile(path.join(job.outDir, entry.diffFile), Buffer.from(diff, 'base64'));
      }
    } catch (e) {
      entry.error = String(e.message || e).split('\n')[0];
    }
    pairs.push(entry);
  }
  await page.close();
  return { pairs };
}

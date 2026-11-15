// Runs inside the Playwright container: node runner.mjs < job.json
// Reads the job from stdin, writes PNGs into job.outDir and prints the result as the last line of stdout.
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { runCompare } from './compare.mjs';

const stdin = [];
for await (const chunk of process.stdin) stdin.push(chunk);
const job = JSON.parse(Buffer.concat(stdin).toString('utf8'));
const playwright = createRequire(path.join(job.modules, 'package.json'))('playwright');

// Last line of defence for "nothing runs while idle": the container never outlives this.
setTimeout(() => {
  console.error(`web: hard timeout after ${job.hardTimeout} ms`);
  process.exit(124);
}, job.hardTimeout).unref();

const FREEZE_CSS = `*, *::before, *::after {
  transition: none !important;
  animation-delay: 0s !important;
  animation-duration: 0s !important;
  animation-iteration-count: 1 !important;
  caret-color: transparent !important;
  scroll-behavior: auto !important;
}`;

const MASK_CSS = `[data-lens-mask] {
  background: COLOR !important;
  border-color: COLOR !important;
  color: transparent !important;
  text-shadow: none !important;
  box-shadow: none !important;
}
[data-lens-mask] *, :is(img, video, canvas, svg, iframe, object, embed)[data-lens-mask] {
  visibility: hidden !important;
}`;

function padding(value) {
  const p = Array.isArray(value) ? value : [value ?? 0];
  const [top, right = top, bottom = top, left = right] = p;
  return { top, right, bottom, left };
}

async function settle(page, v, state) {
  await page.evaluate(() => Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 5000))]));
  try {
    await page.waitForLoadState('networkidle', { timeout: v.idleTimeout });
  } catch {
    // Streaming or polling pages never go idle: shoot anyway and record it.
    state.networkIdle = false;
  }
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function runAction(page, a) {
  const opt = a.timeout ? { timeout: a.timeout } : {};
  if (a.click !== undefined) return page.locator(a.click).first().click(opt);
  if (a.hover !== undefined) return page.locator(a.hover).first().hover(opt);
  if (a.focus !== undefined) return page.locator(a.focus).first().focus(opt);
  if (a.fill !== undefined) return page.locator(a.fill).first().fill(String(a.value ?? ''), opt);
  if (a.press !== undefined) {
    return a.selector ? page.locator(a.selector).first().press(a.press, opt) : page.keyboard.press(a.press);
  }
  if (a.scrollTo !== undefined) {
    const t = a.scrollTo;
    if (typeof t === 'number') return page.evaluate((y) => window.scrollTo(0, y), t);
    if (typeof t === 'object') return page.evaluate(({ x = 0, y = 0 }) => window.scrollTo(x, y), t);
    return page.locator(t).first().scrollIntoViewIfNeeded(opt);
  }
  if (a.waitFor !== undefined) return page.locator(a.waitFor).first().waitFor({ state: a.state ?? 'visible', ...opt });
  if (a.wait !== undefined) return page.waitForTimeout(a.wait);
  if (a.eval !== undefined) return page.evaluate(a.eval);
  throw new Error(`unknown action ${JSON.stringify(a)}`);
}

function pageMetrics(page) {
  return page.evaluate(() => {
    const d = document.documentElement;
    const b = document.body;
    return {
      page: {
        width: Math.max(d.scrollWidth, b ? b.scrollWidth : 0),
        height: Math.max(d.scrollHeight, b ? b.scrollHeight : 0),
      },
      scroll: { x: window.scrollX, y: window.scrollY },
    };
  });
}

// Boxes are in page coordinates (getBoundingClientRect + scroll), so they are comparable across scroll positions.
function measure(page, selector, styles, max) {
  return page.locator(selector).evaluateAll(
    (els, { styles, max }) => {
      const r2 = (n) => Math.round(n * 100) / 100;
      return {
        count: els.length,
        matches: els.slice(0, max).map((el) => {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          const out = {
            tag: el.tagName.toLowerCase(),
            box: { x: r2(r.x + scrollX), y: r2(r.y + scrollY), width: r2(r.width), height: r2(r.height) },
            visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none',
            text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
          };
          if (styles.length) out.styles = Object.fromEntries(styles.map((p) => [p, cs.getPropertyValue(p)]));
          return out;
        }),
      };
    },
    { styles, max },
  );
}

async function pngSize(file) {
  const fd = await fs.open(file);
  try {
    const buf = Buffer.alloc(24);
    await fd.read(buf, 0, 24, 0);
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } finally {
    await fd.close();
  }
}

// depth: lines nested deeper than this are dropped (0 = top level only); maxChars cuts the rest.
function trimSnapshot(text) {
  let lines = text.split('\n');
  if (job.depth !== null && job.depth >= 0) {
    lines = lines.filter((line) => (line.length - line.trimStart().length) / 2 <= job.depth);
  }
  const full = lines.join('\n');
  if (!(job.maxChars > 0) || full.length <= job.maxChars) return { snapshot: full };
  const cut = full.lastIndexOf('\n', job.maxChars);
  const kept = full.slice(0, cut > 0 ? cut : job.maxChars);
  return { snapshot: kept, truncated: full.length - kept.length };
}

async function runVariant(browser, v) {
  const started = Date.now();
  const entry = {
    name: v.name,
    file: v.file,
    url: v.url,
    viewport: v.viewport,
    scale: v.scale,
    scheme: v.scheme,
    target: v.target,
  };
  if (v.browser !== 'chromium') entry.browser = v.browser;
  if (v.selector) entry.selector = v.selector;
  const state = { networkIdle: true };
  const pageErrors = [];
  const consoleErrors = [];
  const failedRequests = [];
  const short = (text) => String(text).split('\n')[0].slice(0, 300);
  const origin = new URL(v.url).origin;
  const context = await browser.newContext({
    viewport: { width: v.viewport.width, height: v.viewport.height },
    deviceScaleFactor: v.scale,
    colorScheme: v.scheme,
    locale: v.locale,
    timezoneId: v.timezone,
    extraHTTPHeaders: v.headers,
    userAgent: v.userAgent,
    isMobile: v.isMobile || undefined,
    hasTouch: v.isMobile || undefined,
    reducedMotion: v.reducedMotion,
    ignoreHTTPSErrors: true,
  });
  try {
    context.setDefaultTimeout(v.timeout);
    if (v.cookies?.length) {
      await context.addCookies(v.cookies.map((c) => (c.url || c.domain ? c : { ...c, url: origin })));
    }
    if (v.localStorage && Object.keys(v.localStorage).length) {
      await context.addInitScript(
        ({ items, origin }) => {
          if (location.origin !== origin) return;
          for (const [k, val] of Object.entries(items)) {
            localStorage.setItem(k, typeof val === 'string' ? val : JSON.stringify(val));
          }
        },
        { items: v.localStorage, origin },
      );
    }
    if (v.animations !== 'allow') {
      await context.addInitScript((css) => {
        const add = () => {
          const s = document.createElement('style');
          s.setAttribute('data-lens', 'freeze');
          s.textContent = css;
          (document.head || document.documentElement).appendChild(s);
        };
        if (document.documentElement) add();
        else document.addEventListener('DOMContentLoaded', add);
      }, FREEZE_CSS);
    }
    const page = await context.newPage();
    page.on('pageerror', (e) => pageErrors.push(short(e.message || e)));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const at = m.location()?.url;
      consoleErrors.push(short(m.text()) + (at && at !== v.url ? `  (${at})` : ''));
    });
    const failed = (r, why) => failedRequests.push(`${r.method()} ${r.url()}: ${why}`);
    page.on('requestfailed', (r) => failed(r, r.failure()?.errorText ?? 'failed'));
    page.on('response', (r) => {
      if (r.status() >= 400 && r.url() !== v.url) failed(r.request(), `HTTP ${r.status()}`);
    });
    if (v.date) await page.clock.setFixedTime(new Date(v.date));

    const response = await page.goto(v.url, { waitUntil: v.waitUntil, timeout: v.timeout });
    entry.status = response ? response.status() : null;
    if (response && response.status() >= 400 && !v.allowHttpErrors) {
      throw new Error(`HTTP ${response.status()} for ${v.url} (set allowHttpErrors to shoot it anyway)`);
    }
    await settle(page, v, state);

    // Centre the target before the actions run: scrolling afterwards would move it away from a hovering mouse.
    if (v.selector) {
      await page
        .locator(v.selector)
        .first()
        .evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }), null, {
          timeout: 250,
        })
        .catch(() => {});
    }
    for (const [i, a] of v.actions.entries()) {
      try {
        await runAction(page, a);
      } catch (e) {
        throw new Error(`action ${i + 1} ${JSON.stringify(a)} failed: ${String(e.message).split('\n')[0]}`);
      }
    }
    if (v.actions.length) await settle(page, v, state);

    // Masks are painted into the page instead of using Playwright's overlay, which would also cover anything
    // stacked above the masked element (an open menu, a modal).
    if (v.mask.length) {
      await page.addStyleTag({ content: MASK_CSS.replaceAll('COLOR', v.maskColor) });
      for (const sel of v.mask) {
        await page.locator(sel).evaluateAll((els) => els.forEach((el) => el.setAttribute('data-lens-mask', '')));
      }
    }

    let clip = null;
    if (v.selector) {
      const target = page.locator(v.selector);
      await target.first().waitFor({ state: 'attached', timeout: v.selectorTimeout }).catch(() => {});
      const m = await measure(page, v.selector, v.styles, 1);
      if (m.count === 0) throw new Error(`selector ${JSON.stringify(v.selector)} matched nothing`);
      entry.matches = m.count;
      entry.box = m.matches[0].box;
      if (m.matches[0].styles) entry.styles = m.matches[0].styles;
      if (!m.matches[0].visible) {
        throw new Error(`selector ${JSON.stringify(v.selector)} matched an element that is not visible (0x0, hidden)`);
      }
      const p = padding(v.padding);
      const b = entry.box;
      clip = {
        x: b.x - p.left, y: b.y - p.top, width: b.width + p.left + p.right, height: b.height + p.top + p.bottom,
      };
    } else if (v.clip) {
      clip = { ...v.clip };
    }

    Object.assign(entry, await pageMetrics(page));
    if (v.measure.length) {
      entry.elements = {};
      for (const sel of v.measure) {
        entry.elements[sel] = await measure(page, sel, v.styles, v.maxMatches);
        if (entry.elements[sel].count === 0) throw new Error(`measure selector ${JSON.stringify(sel)} matched nothing`);
      }
    }

    if (job.mode === 'shot') {
      const opts = {
        path: path.join(job.outDir, v.file),
        type: 'png',
        scale: 'device',
        caret: 'hide',
        animations: v.animations === 'allow' ? 'allow' : 'disabled',
      };
      if (clip) {
        const x0 = Math.max(0, Math.floor(clip.x));
        const y0 = Math.max(0, Math.floor(clip.y));
        const x1 = Math.min(entry.page.width, Math.ceil(clip.x + clip.width));
        const y1 = Math.min(entry.page.height, Math.ceil(clip.y + clip.height));
        if (x1 <= x0 || y1 <= y0) throw new Error(`clip ${JSON.stringify(clip)} is outside the page`);
        entry.clip = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
        const vx = x0 - entry.scroll.x;
        const vy = y0 - entry.scroll.y;
        const inViewport = vx >= 0 && vy >= 0 && x1 - entry.scroll.x <= v.viewport.width
          && y1 - entry.scroll.y <= v.viewport.height;
        // Inside the viewport the plain capture is the most faithful one (fixed and sticky elements, hover).
        if (inViewport) opts.clip = { x: vx, y: vy, width: entry.clip.width, height: entry.clip.height };
        else Object.assign(opts, { fullPage: true, clip: entry.clip });
      } else if (v.target === 'full') {
        opts.fullPage = true;
      }
      await page.screenshot(opts);
      entry.image = await pngSize(opts.path);
    }
    if (job.mode === 'snapshot') {
      const root = page.locator(v.selector ?? 'body').first();
      Object.assign(entry, trimSnapshot(await root.ariaSnapshot({ timeout: v.timeout })));
    }
    entry.networkIdle = state.networkIdle;
    if (v.failOnConsoleError && (consoleErrors.length || pageErrors.length)) {
      if (job.mode === 'shot') await fs.rm(path.join(job.outDir, v.file), { force: true });
      throw new Error(`${consoleErrors.length} console errors, ${pageErrors.length} page errors: `
        + (consoleErrors[0] ?? pageErrors[0]));
    }
  } catch (e) {
    entry.error = String(e.message || e).split('\n')[0];
  } finally {
    if (pageErrors.length) entry.pageErrors = pageErrors;
    if (consoleErrors.length) entry.consoleErrors = consoleErrors;
    if (failedRequests.length) entry.failedRequests = failedRequests;
    await context.close();
  }
  entry.ms = Date.now() - started;
  return entry;
}

async function runShots(browsers) {
  const results = new Array(job.variants.length);
  let next = 0;
  const worker = async () => {
    while (next < job.variants.length) {
      const i = next++;
      const v = job.variants[i];
      results[i] = await browsers(v.browser).then((browser) => runVariant(browser, v)).catch((e) => ({
        name: job.variants[i].name,
        file: job.variants[i].file,
        error: String(e.message || e).split('\n')[0],
      }));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(job.jobs, job.variants.length)) }, worker));
  return { shots: results };
}

// each browser is started once, on first use
const launched = new Map();
const browsers = (name = 'chromium') => {
  if (!launched.has(name)) launched.set(name, playwright[name].launch());
  return launched.get(name);
};
let result;
try {
  result = job.mode === 'compare' ? await runCompare(await browsers(), job) : await runShots(browsers);
} finally {
  for (const browser of launched.values()) await (await browser.catch(() => null))?.close();
}
process.stdout.write(`\n${JSON.stringify(result)}\n`);

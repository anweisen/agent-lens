// Flags and spec files of shot, measure and snapshot: parsing and expansion into one variant per
// viewport, scale, scheme and browser.
import { parseArgs } from 'node:util';

export const PRESETS = { mobile: [375, 812], tablet: [768, 1024], desktop: [1440, 900] };
const DEFAULTS = {
  path: '/',
  viewports: ['desktop'],
  scales: [1],
  schemes: ['light'],
  browsers: ['chromium'],
  padding: 0,
  mask: [],
  maskColor: '#ff00ff',
  setup: [],
  actions: [],
  measure: [],
  styles: [],
  waitUntil: 'load',
  timeout: 15000,
  idleTimeout: 5000,
  selectorTimeout: 2000,
  maxMatches: 50,
  animations: 'disabled',
};

const BROWSERS = ['chromium', 'webkit', 'firefox'];

export class UsageError extends Error {}

export const list = (v) => (v === undefined || v === null ? undefined : (Array.isArray(v) ? v : [v]));
export const csv = (values) => values?.flatMap((v) => String(v).split(',')).map((s) => s.trim()).filter(Boolean);

function parseViewport(v) {
  if (typeof v === 'object' && v) return { name: v.name || `${v.width}x${v.height}`, width: v.width, height: v.height };
  if (PRESETS[v]) return { name: v, width: PRESETS[v][0], height: PRESETS[v][1] };
  const m = /^(\d+)x(\d+)$/.exec(String(v));
  if (!m) throw new UsageError(`unknown viewport ${JSON.stringify(v)} (use ${Object.keys(PRESETS).join(', ')} or WxH)`);
  return { name: v, width: Number(m[1]), height: Number(m[2]) };
}

function parseAction(s) {
  if (s.trim().startsWith('{')) return JSON.parse(s);
  const i = s.indexOf(':');
  if (i < 0) throw new UsageError(`--action ${JSON.stringify(s)}: expected type:argument`);
  const type = s.slice(0, i);
  const arg = s.slice(i + 1);
  if (type === 'wait') return { wait: Number(arg) };
  if (type === 'scrollTo') return { scrollTo: /^\d+$/.test(arg) ? Number(arg) : arg };
  if (type === 'fill') {
    const j = arg.lastIndexOf('=>');
    if (j < 0) throw new UsageError('--action fill: expected fill:<selector>=><text>');
    return { fill: arg.slice(0, j), value: arg.slice(j + 2) };
  }
  if (!['click', 'hover', 'focus', 'press', 'waitFor', 'eval'].includes(type)) {
    throw new UsageError(`--action: unknown type ${JSON.stringify(type)}`);
  }
  return { [type]: arg };
}

const pair = (flag, s, sep) => {
  const i = s.indexOf(sep);
  if (i < 0) throw new UsageError(`${flag} ${JSON.stringify(s)}: expected name${sep}value`);
  return [s.slice(0, i).trim(), s.slice(i + sep.length).trim()];
};

// Singular spellings are accepted everywhere; internally the plural arrays are used.
function normalize(o) {
  const n = { ...o };
  for (const [one, many] of [['viewport', 'viewports'], ['scale', 'scales'], ['scheme', 'schemes'],
    ['browser', 'browsers']]) {
    if (n[one] !== undefined && n[many] === undefined) n[many] = n[one];
    delete n[one];
    if (n[many] !== undefined) n[many] = list(n[many]);
  }
  for (const k of ['mask', 'measure', 'styles']) if (n[k] !== undefined) n[k] = list(n[k]);
  return n;
}

export const SHOT_OPTIONS = {
  spec: { type: 'string' }, url: { type: 'string' }, 'base-url': { type: 'string' }, path: { type: 'string' },
  name: { type: 'string' }, out: { type: 'string' }, serve: { type: 'string' }, spa: { type: 'boolean' },
  viewport: { type: 'string', multiple: true }, scale: { type: 'string', multiple: true },
  scheme: { type: 'string', multiple: true }, selector: { type: 'string', multiple: true },
  padding: { type: 'string' }, target: { type: 'string' }, full: { type: 'boolean' }, clip: { type: 'string' },
  action: { type: 'string', multiple: true }, mask: { type: 'string', multiple: true },
  'mask-color': { type: 'string' }, measure: { type: 'string', multiple: true },
  style: { type: 'string', multiple: true }, header: { type: 'string', multiple: true },
  cookie: { type: 'string', multiple: true }, 'local-storage': { type: 'string', multiple: true },
  locale: { type: 'string' }, timezone: { type: 'string' }, date: { type: 'string' },
  'wait-until': { type: 'string' }, 'idle-timeout': { type: 'string' }, timeout: { type: 'string' },
  animations: { type: 'string' }, mobile: { type: 'boolean' }, 'allow-http-errors': { type: 'boolean' },
  only: { type: 'string', multiple: true }, jobs: { type: 'string' }, json: { type: 'boolean' },
  browser: { type: 'string', multiple: true }, 'fail-on-console-error': { type: 'boolean' },
};
const COMMON_OPTIONS = {
  dns: { type: 'string', multiple: true }, 'max-time': { type: 'string' }, 'keep-job': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

export function parse(argv, options) {
  try {
    return parseArgs({ args: argv, options: { ...options, ...COMMON_OPTIONS }, allowPositionals: false }).values;
  } catch (e) {
    throw new UsageError(e.message);
  }
}

export const common = (f) => ({
  dns: f.dns ?? [],
  hardTimeout: Number(f['max-time'] ?? 600) * 1000,
  keep: Boolean(f['keep-job']),
});

export function flagOverrides(f, mode) {
  const o = {};
  const set = (k, v) => {
    if (v !== undefined) o[k] = v;
  };
  set('url', f.url);
  set('baseUrl', f['base-url']);
  set('path', f.path);
  set('name', f.name);
  set('viewports', csv(f.viewport));
  set('scales', csv(f.scale)?.map(Number));
  set('schemes', csv(f.scheme));
  set('browsers', csv(f.browser));
  if (f.selector) {
    if (mode === 'measure') o.measure = [...f.selector, ...(f.measure ?? [])];
    else if (f.selector.length > 1) throw new UsageError('shot takes one --selector (use --measure for further ones)');
    else o.selector = f.selector[0];
  }
  if (mode !== 'measure') set('measure', f.measure);
  set('padding', f.padding?.includes(',') ? f.padding.split(',').map(Number) : f.padding && Number(f.padding));
  set('target', f.full ? 'full' : f.target);
  if (f.clip) {
    const [x, y, width, height] = f.clip.split(',').map(Number);
    if (![x, y, width, height].every(Number.isFinite)) throw new UsageError('--clip: expected x,y,width,height');
    o.clip = { x, y, width, height };
  }
  set('actions', f.action?.map(parseAction));
  set('mask', f.mask);
  set('maskColor', f['mask-color']);
  set('styles', csv(f.style));
  set('headers', f.header && Object.fromEntries(f.header.map((h) => pair('--header', h, ':'))));
  set('cookies', f.cookie?.map((c) => {
    const [name, value] = pair('--cookie', c, '=');
    return { name, value };
  }));
  const stored = f['local-storage']?.map((s) => pair('--local-storage', s, '='));
  set('localStorage', stored && Object.fromEntries(stored));
  set('locale', f.locale);
  set('timezone', f.timezone);
  set('date', f.date);
  set('waitUntil', f['wait-until']);
  set('idleTimeout', f['idle-timeout'] && Number(f['idle-timeout']));
  set('timeout', f.timeout && Number(f.timeout));
  set('animations', f.animations);
  set('isMobile', f.mobile);
  set('allowHttpErrors', f['allow-http-errors']);
  set('failOnConsoleError', f['fail-on-console-error']);
  return o;
}

function defaultName(s) {
  const p = s.url ? new URL(s.url).pathname : s.path;
  return p.replace(/\.html?$/, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'index';
}

// Precedence per field: flag > shot > spec top level > default.
export function expand(spec, flags, mode, only) {
  const { shots, ...top } = normalize(spec);
  const variants = [];
  for (const raw of shots?.length ? shots : [{}]) {
    const s = { ...DEFAULTS, ...top, ...normalize(raw), ...flags };
    if (!s.url) {
      if (!s.baseUrl) throw new UsageError('no page given: use --url, --base-url (+ --path), --serve or a spec');
      const base = s.baseUrl.replace(/\/+$/, '');
      s.url = /^https?:/.test(s.path) ? s.path : base + (s.path.startsWith('/') ? '' : '/') + s.path;
    }
    try {
      new URL(s.url);
    } catch {
      throw new UsageError(`invalid URL ${JSON.stringify(s.url)}`);
    }
    s.name ??= defaultName(s);
    if (only && !only.includes(s.name)) continue;
    if (mode !== 'shot') s.clip = null;
    if (mode === 'measure') {
      s.measure = [...new Set([s.selector, ...s.measure].filter(Boolean))];
      if (!s.measure.length) throw new UsageError(`measure: shot ${s.name} has no selector`);
      s.selector = null;
      s.clip = null;
    }
    s.target = s.selector ? 'section' : s.clip ? 'clip' : (s.target === 'viewport' ? 'viewport' : 'full');
    if (s.target !== 'section') s.selector = null;
    if (s.target !== 'clip') s.clip = null;
    for (const sc of s.scales) if (!(sc > 0)) throw new UsageError(`invalid scale ${JSON.stringify(sc)}`);
    for (const sch of s.schemes) {
      if (!['light', 'dark'].includes(sch)) throw new UsageError(`invalid scheme ${JSON.stringify(sch)}`);
    }
    for (const browser of s.browsers) {
      if (!BROWSERS.includes(browser)) {
        throw new UsageError(`unknown browser ${JSON.stringify(browser)} (use ${BROWSERS.join(', ')})`);
      }
    }
    const { shots: _s, viewports, scales, schemes, browsers, setup, baseUrl, path: _p, out, ...rest } = s;
    const actions = [...list(setup), ...list(s.actions)];
    for (const browser of browsers) {
      for (const vp of viewports.map(parseViewport)) {
        for (const scale of scales) {
          for (const scheme of schemes) {
            const stem = [s.name, vp.name, ...(browser === 'chromium' ? [] : [browser])].join('.')
              + (scale !== 1 ? `@${scale}x` : '') + (scheme === 'dark' ? '.dark' : '');
            variants.push({ ...rest, file: `${stem}.png`, browser, viewport: vp, scale, scheme, actions });
          }
        }
      }
    }
  }
  if (!variants.length) throw new UsageError('nothing to do (no shot matches --only)');
  const seen = new Set();
  for (const v of variants) {
    if (seen.has(v.file)) throw new UsageError(`two shots produce ${v.file}: give them different names`);
    seen.add(v.file);
  }
  return variants;
}

export const boxStr = (b) => `${b.x},${b.y} ${b.width}x${b.height}`;

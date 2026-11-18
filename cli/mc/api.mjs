// mc <api command>: thin mapping of command lines onto the HTTP API of the lens mod (docs/api.md).
import fs from 'node:fs';
import path from 'node:path';
import { camel, splitArgs, typed as typedValue } from '../core/args.mjs';
import { printResult, printable } from '../core/format.mjs';
import { APP, envVar, expandHome } from '../core/paths.mjs';
import { readClient, readModState } from '../core/state.mjs';
import { getSession } from './auth.mjs';
import { findConflicts } from './conflicts.mjs';
import { hasLensMod, start, stop, waitReady } from './launcher.mjs';
import { defaultAuth, resolveServer } from './servers.mjs';
import { muxRecording } from './video.mjs';

export class ApiError extends Error {}

// Command -> endpoint. Flags map mechanically onto body fields: --gui-scale 4 -> guiScale: 4, and a flag that
// starts with one of NESTED goes one level down: --hover-slot 13 -> hover: {slot: 13}.
//   positionals: body fields filled from positional arguments, in order
//   rest: all positional arguments joined by a space into this field
//   many: every positional argument is one entry of this field (one entry: scalar, several: array)
export const COMMANDS = {
  connect: { positionals: ['server'] },
  singleplayer: { positionals: ['world'] },
  disconnect: { noStart: true },
  quit: { noStart: true },
  wait: { positionals: ['for', 'match'] },
  chat: { rest: 'text' },
  key: { positionals: ['key', 'action'] },
  type: { rest: 'text' },
  click: {},
  hover: {},
  use: { positionals: ['target'] },
  attack: { positionals: ['target'] },
  hotbar: { positionals: ['slot'] },
  look: {},
  camera: { positionals: ['mode'] },
  settings: {},
  resourcepack: { positionals: ['path'] },
  screen: { method: 'GET' },
  hud: { method: 'GET' },
  regions: { method: 'GET' },
  texts: { method: 'GET' },
  capture: { many: 'region' },
  // capture with defaults for evidence: a target instead of regions, hover by item name, content never cut off
  shot: { positionals: ['target'], endpoint: 'capture' },
  // checked by the CLI against /screen and /hud, no endpoint of its own
  expect: { local: true },
  frames: { many: 'region' },
  compose: {},
  record: { positionals: ['action'] },
};

const NESTED = ['hover', 'create', 'fixed', 'window'];
// never auto-typed: "42" stays a string
const STRINGS = new Set(['text', 'world', 'match', 'widget', 'key', 'out', 'before', 'after', 'server', 'label',
  'path', 'item', 'screen', 'chat', 'target']);
const FILES = ['out', 'before', 'after'];
// consumed by the CLI, never sent
const CLI_FLAGS = new Set(['json', 'restart', 'force', 'no-start', 'http-timeout', 'brief']);

const typed = (key, raw) => typedValue(key, raw, STRINGS);

export function bodyFromArgs(name, argv) {
  const spec = COMMANDS[name];
  // "--chat" is a switch for capture; for expect it takes a pattern, spaces included
  if (name === 'expect') {
    argv = argv.flatMap((arg, index) => (arg === '--chat' && argv[index + 1] !== undefined
      ? [`--chat=${argv[index + 1]}`] : argv[index - 1] === '--chat' ? [] : [arg]));
  }
  const { flags, positionals } = splitArgs(argv);
  const cli = {};
  const body = {};
  for (const [flag, raw] of Object.entries(flags)) {
    if (CLI_FLAGS.has(flag)) {
      cli[camel(flag)] = raw;
      continue;
    }
    const parent = NESTED.find(prefix => flag === prefix || flag.startsWith(`${prefix}-`));
    if (!parent) body[camel(flag)] = typed(camel(flag), raw);
    else if (flag === parent) body[parent] = raw === true ? { ...body[parent] } : typed(parent, raw);
    else {
      const key = camel(flag.slice(parent.length + 1));
      body[parent] = { ...body[parent], [key]: typed(key, raw) };
    }
  }
  if (spec.rest) {
    if (positionals.length) body[spec.rest] = positionals.join(' ');
  } else if (spec.many) {
    const values = positionals.map(value => typed(spec.many, value));
    if (values.length) body[spec.many] = values.length === 1 ? values[0] : values;
  } else {
    const fields = spec.positionals || [];
    if (positionals.length > fields.length) {
      throw new Error(`mc ${name}: unexpected argument "${positionals[fields.length]}" (quote values with spaces)`);
    }
    positionals.forEach((value, index) => {
      body[fields[index]] = typed(fields[index], value);
    });
  }
  // "wait ticks 20" reads better than "wait ticks --ticks 20"
  if (name === 'wait' && body.for === 'ticks' && body.ticks === undefined && /^\d+$/.test(body.match ?? '')) {
    body.ticks = Number(body.match);
    delete body.match;
  }
  return { body, cli };
}

// A scene step value: an object is the body itself, a scalar fills the first positional field.
export function bodyFromStep(name, value) {
  const spec = COMMANDS[name];
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return { ...value };
  if (value === null || value === true) return {};
  const field = spec.rest || spec.many || spec.positionals?.[0];
  if (!field) throw new Error(`"${name}" takes an object, not ${JSON.stringify(value)}`);
  return { [field]: value };
}

// "shot" targets -> capture regions. Anything else is taken as a region name (chat, actionbar, sidebar, ...).
const SHOT_TARGETS = { menu: 'screen', tooltip: 'tooltip', 'menu+tooltip': ['screen', 'tooltip'] };

// A shot is a capture: {target, item | slot | widget, ...} -> {region, hover, fit, pad, ...}.
export function shotBody({ target = 'menu', item, slot, widget, text, ...rest }) {
  const hover = rest.hover
    ?? (item !== undefined ? { item: String(item) } : slot !== undefined ? { slot } : widget !== undefined
      ? { widget } : text !== undefined ? { text: String(text) } : undefined);
  let region = SHOT_TARGETS[target] ?? target;
  if (target === 'item') {
    if (hover?.item === undefined && hover?.slot === undefined) {
      throw new Error('shot item: needs --item <name> or --slot <n> (the slot and its tooltip are captured)');
    }
    region = [hover.item !== undefined ? `item:${hover.item}` : `slot:${hover.slot}`, 'tooltip'];
  }
  return { fit: true, pad: 8, ...rest, region, ...(hover ? { hover } : {}) };
}

const pattern = text => {
  try {
    return new RegExp(text, 'iu');
  } catch {
    return new RegExp(String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
  }
};
// Text for reading and matching: no legacy formatting codes, and no private-use characters (a server pack maps
// them to GUI textures; a menu title can be kilobytes of them before the words).
export const plain = text => String(text ?? '').replace(/\u00a7./g, '')
  .replace(/[\ue000-\uf8ff\u{f0000}-\u{10ffff}]+/gu, '').trim();
const simpleClass = name => String(name ?? '').split('.').pop();

// One round of checks against the current state; returns the list of unmet conditions as text.
async function expectOnce(context, body) {
  const misses = [];
  const seen = {};
  const screen = await context.call('GET', '/screen');
  const title = screen.class ? plain(screen.title) : null;
  seen.screen = screen.class ? `${title} (${simpleClass(screen.class)})` : null;
  if (body.noScreen && screen.class) misses.push(`expected no screen, open: ${seen.screen}`);
  if (body.screen !== undefined) {
    const wanted = pattern(body.screen);
    if (!screen.class) misses.push(`expected screen /${body.screen}/, no screen is open`);
    else if (!wanted.test(title) && !wanted.test(screen.class)) {
      misses.push(`expected screen /${body.screen}/, open: ${seen.screen}`);
    }
  }
  const items = (screen.slots || []).filter(slot => slot.item).map(slot => ({ index: slot.index,
    name: plain(slot.item.name), tooltip: (slot.item.tooltip || []).map(plain), player: Boolean(slot.player) }));
  if (body.item !== undefined) {
    const wanted = pattern(body.item);
    const found = items.filter(item => wanted.test(item.name));
    if (found.length) seen.item = found.map(item => `${item.index} ${item.name}`).join(', ');
    else {
      const named = items.filter(item => item.name);
      const names = (named.some(item => !item.player) ? named.filter(item => !item.player) : named)
        .map(item => `${item.index} ${item.name}`);
      misses.push(`expected an item /${body.item}/, items: ${names.join(', ') || 'none'}`);
    }
    if (body.tooltip !== undefined && found.length) {
      const line = pattern(body.tooltip);
      const hit = found.find(item => item.tooltip.some(text => line.test(text)));
      if (hit) seen.tooltip = hit.tooltip.find(text => line.test(text));
      else misses.push(`expected a tooltip line /${body.tooltip}/ on ${seen.item}, lines: `
        + JSON.stringify(found[0].tooltip));
    }
  } else if (body.tooltip !== undefined) {
    misses.push('"tooltip" needs "item": the tooltip lines of that item are searched');
  }
  if (body.widget !== undefined) {
    const wanted = pattern(body.widget);
    const labels = (screen.widgets || []).map(widget => plain(widget.label)).filter(Boolean);
    const found = labels.find(label => wanted.test(label));
    if (found) seen.widget = found;
    else misses.push(`expected a widget /${body.widget}/, widgets: ${labels.join(' | ') || 'none'}`);
  }
  if (body.text !== undefined) {
    const wanted = pattern(body.text);
    const { texts } = await context.call('GET', '/texts');
    const all = [...new Set(texts.map(entry => plain(entry.text)).filter(Boolean))];
    const found = all.find(text => wanted.test(text));
    if (found) seen.text = found;
    else misses.push(`expected text /${body.text}/ on screen, texts: ${JSON.stringify(all.slice(0, 30))}`);
  }
  if (body.chat !== undefined) {
    const wanted = pattern(body.chat);
    const hud = await context.call('GET', '/hud', { lines: Number(body.lines) || 20 });
    const lines = (hud.chat?.lines || []).map(plain);
    const found = lines.findLast(line => wanted.test(line));
    if (found) seen.chat = found;
    else misses.push(`expected a chat line /${body.chat}/, last lines: ${JSON.stringify(lines.slice(-5))}`);
  }
  return { misses, seen };
}

// Polls until every condition holds, so it also replaces a wait. Fails with what is there instead: text the
// caller can act on without a screenshot.
async function expect(context, body) {
  const known = ['screen', 'noScreen', 'item', 'tooltip', 'widget', 'chat', 'text', 'lines', 'timeoutMs'];
  const unknown = Object.keys(body).filter(key => !known.includes(key));
  if (unknown.length) throw new Error(`expect: unknown field ${unknown.join(', ')} (${known.join(', ')})`);
  if (!known.slice(0, 7).some(key => body[key] !== undefined)) {
    throw new Error('expect: give at least one of --screen, --no-screen, --item, --widget, --chat, --text');
  }
  const timeoutMs = body.timeoutMs === undefined ? 5000 : Number(body.timeoutMs);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { misses, seen } = await expectOnce(context, body);
    if (!misses.length) return seen;
    if (Date.now() >= deadline) throw new ApiError(printable(`${misses.join('; ')} (after ${timeoutMs} ms)`));
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function request(base, method, apiPath, body, timeoutMs = 300_000) {
  const options = { method, signal: AbortSignal.timeout(timeoutMs) };
  if (method !== 'GET' && method !== 'HEAD') {
    options.headers = { 'content-type': 'application/json' };
    options.body = JSON.stringify(body ?? {});
  }
  let response;
  try {
    response = await fetch(base + apiPath, options);
  } catch (error) {
    const timedOut = error.name === 'TimeoutError';
    const reason = timedOut ? `no answer within ${timeoutMs / 1000} s` : error.cause?.code || error.message;
    throw new ApiError(`${method} ${apiPath}: lens API at ${base} failed (${reason}); see "${APP} mc logs"`);
  }
  const text = await response.text();
  let data = text;
  try {
    data = text === '' ? {} : JSON.parse(text);
  } catch {
    // not JSON: keep the text
  }
  if (!response.ok) {
    const message = data?.error ?? (typeof data === 'string' && data ? data.slice(0, 500) : `HTTP ${response.status}`);
    throw new ApiError(`${method} ${apiPath}: ${message}`);
  }
  return data;
}

// One context per CLI invocation or scene run. The client is looked up (and started if needed) at most once per
// session mode.
export function createContext(config, { restart = false, force = false, noStart = false, log = console.error } = {}) {
  let base = null;
  const context = {
    config,
    log,
    // session mode for a client this context has to start before a command names one (set by a scene run)
    startAuth: null,
    async ensure({ auth, autoStart = true } = {}) {
      let client = readClient();
      const running = client ? client.auth || 'offline' : null;
      if (client && auth && running !== auth) {
        if (!restart) {
          throw new Error(`the running client (pid ${client.pid}) runs with session "${running}", this needs `
            + `"${auth}". Repeat with --restart: the client is stopped and started again, its world or server `
            + 'connection is lost.');
        }
        log(`restarting the client with a ${auth} session`);
        await stop();
        client = null;
        base = null;
      }
      if (base && client) return base;
      if (!client) {
        if (!autoStart || noStart) throw new Error('the client is not running');
        if (!hasLensMod(config)) {
          const mods = path.join(config.dirs.game, 'mods');
          throw new Error(`no lens mod jar in ${mods} (run mod/install.sh from the repository, or copy the jar there)`);
        }
        const mode = auth || context.startAuth || defaultAuth(config);
        const session = mode === 'microsoft' ? await getSession(config) : undefined;
        log(`starting the client (${mode} session${session ? `, account ${session.name}` : ''})`);
        client = await start(config, { session, log });
      }
      const ready = await waitReady(config);
      if (ready.signal !== 'mod') throw new Error('the running client has no lens mod (no API state file)');
      base = `http://127.0.0.1:${ready.port}`;
      return base;
    },
    async call(method, apiPath, body, options = {}) {
      const url = await context.ensure(options);
      const waits = Number(body?.timeoutMs) > 0 ? Number(body.timeoutMs) + 15_000 : undefined;
      const timeoutMs = options.timeoutMs ?? waits;
      // the mod reads fields from the body only and answers a POST on its GET routes
      const send = method === 'GET' && body && Object.keys(body).length ? 'POST' : method;
      return request(url, send, apiPath, body, timeoutMs);
    },
    // name: a key of COMMANDS, body: the API body (for connect: {server})
    async run(name, body = {}, { baseDir = process.cwd() } = {}) {
      const spec = COMMANDS[name];
      if (!spec) throw new Error(`unknown command "${name}"`);
      body = { ...body };
      for (const key of FILES) {
        if (typeof body[key] === 'string') body[key] = path.resolve(baseDir, body[key]);
      }
      if (name === 'resourcepack' && typeof body.path === 'string') body.path = packPath(body.path);
      if (typeof body.out === 'string') fs.mkdirSync(path.dirname(body.out), { recursive: true });
      if (name === 'connect') return connect(context, body, force);
      if (name === 'expect') return expect(context, body);
      if (name === 'shot') body = shotBody(body);
      // nothing to leave without a client: a scene that starts with "disconnect" also runs on a stopped one
      if (name === 'disconnect' && !readClient()) return { wasInWorld: false, running: false };
      const result = await context.call(spec.method || 'POST', `/${spec.endpoint || name}`, body,
        { autoStart: !spec.noStart });
      return name === 'record' && body.action === 'stop' ? muxRecording(config, result) : result;
    },
  };
  return context;
}

// relative to the working directory, not to a scene's output directory; "~/" as in a shell
export const packPath = file => path.resolve(expandHome(file));

// The session server rate-limits logins ("Failed to log in: Status: 429"), typically right after a client start;
// a proxy does the same to quick reconnects ("You are logging in too fast").
const RATE_LIMITED = /Status: 429|logging in too fast/i;
const LOGIN_RETRIES = 3;
const loginRetryMs = () => Number(envVar('LOGIN_RETRY_MS')) || 20_000;

async function connect(context, body, force) {
  const { config } = context;
  if (body.host !== undefined || body.port !== undefined) {
    throw new Error('connect takes a configured server name or its exact host:port, not separate host and port fields');
  }
  const server = resolveServer(config, body.server);
  if (server.auth === 'microsoft' && !force) {
    const conflicts = findConflicts(config);
    if (conflicts.length) {
      const who = conflicts.map(entry => `${entry.name} (pid ${entry.pid})`).join(', ');
      throw new Error(`refused: ${who} is running and uses the same account; joining ${server.name} would kick one `
        + 'of the two. Stop it first, or repeat with --force if that process is not online.');
    }
  }
  const { server: _, ...rest } = body;
  if (server.resourcePack) {
    const pack = await context.call('POST', '/resourcepack', { path: packPath(server.resourcePack) },
      { auth: server.auth });
    if (pack.reloaded) context.log(`applied the resource pack of ${server.name}: ${pack.source}`);
  }
  let result;
  for (let attempt = 0; ; attempt++) {
    try {
      result = await context.call('POST', '/connect', { ...rest, host: server.host, port: server.port },
        { auth: server.auth });
      break;
    } catch (error) {
      if (!(error instanceof ApiError) || !RATE_LIMITED.test(error.message) || attempt >= LOGIN_RETRIES) throw error;
      const pause = loginRetryMs();
      context.log(`login rate-limited, retry ${attempt + 1} of ${LOGIN_RETRIES} in ${pause / 1000} s`);
      await new Promise(resolve => setTimeout(resolve, pause));
    }
  }
  return typeof result === 'object' ? { server: server.name, ...result } : result;
}

// GET /status of a running client without starting one; null when there is no client or no API yet.
export async function peekStatus() {
  const mod = readClient() && readModState();
  if (!mod) return null;
  try {
    return await request(`http://127.0.0.1:${mod.port}`, 'GET', '/status', undefined, 10_000);
  } catch (error) {
    return { error: error.message };
  }
}

function parseApiBody(args) {
  if (!args.length) return undefined;
  if (args.length === 1 && args[0].startsWith('@')) return JSON.parse(fs.readFileSync(args[0].slice(1), 'utf8'));
  if (args.length === 1 && /^[[{"]/.test(args[0])) return JSON.parse(args[0]);
  const body = {};
  for (const pair of args) {
    const split = pair.indexOf('=');
    if (split < 1) throw new Error(`mc api: expected a JSON body, @file or key=value pairs, got "${pair}"`);
    const keys = pair.slice(0, split).split('.');
    let target = body;
    for (const key of keys.slice(0, -1)) target = target[key] ??= {};
    target[keys.at(-1)] = typed(keys.at(-1), pair.slice(split + 1));
  }
  return body;
}

// mc <name> ...: the API commands and the generic "api" escape hatch.
export async function runApiCommand(config, name, argv) {
  if (name === 'api') {
    const { flags, positionals } = splitArgs(argv);
    const [method, apiPath, ...rest] = positionals;
    if (!method || !apiPath?.startsWith('/')) {
      throw new Error(`usage: ${APP} mc api <METHOD> </path> [json | @file | key=value ...]`);
    }
    const context = createContext(config, { noStart: Boolean(flags['no-start']) });
    printResult(await context.call(method.toUpperCase(), apiPath, parseApiBody(rest)), flags.json);
    return 0;
  }
  const { body, cli } = bodyFromArgs(name, argv);
  const context = createContext(config, {
    restart: Boolean(cli.restart), force: Boolean(cli.force), noStart: Boolean(cli.noStart),
  });
  const options = cli.httpTimeout ? { timeoutMs: Number(cli.httpTimeout) * 1000 } : {};
  if (name === 'quit' && !readClient()) {
    console.log('not running');
    return 0;
  }
  if (options.timeoutMs) {
    const call = context.call;
    context.call = (method, apiPath, payload, extra = {}) => call(method, apiPath, payload, { ...extra, ...options });
  }
  const result = await context.run(name, body);
  const { recordStep } = await import('./scene.mjs');
  const recorded = recordStep(name, body);
  if (recorded) console.error(`(recorded as step ${recorded})`);
  if (cli.json) printResult(result, true);
  else if (name === 'shot') console.log(shotText(result));
  else if (name === 'screen' && cli.brief) console.log(briefScreen(result));
  else printResult(result, false);
  return 0;
}

// What a shot shows, as text: enough to check the picture without opening it.
export function shotText(result) {
  const lines = [`${result.file}  ${result.width}x${result.height}  guiScale ${result.guiScale}`];
  if (result.fitted) lines.push(`fitted: the window was ${result.fitted.w}x${result.fitted.h} for this shot`);
  if (result.clipped) {
    lines.push(`CLIPPED: ${result.clipped.join(', ')} reaches beyond the window, the picture is cut off `
      + '(lower --gui-scale)');
  }
  if (result.screenTitle) lines.push(`screen title: ${plain(result.screenTitle)}`);
  if (result.hovered) {
    lines.push(`hovered: slot ${result.hovered.slot}${result.hovered.name ? ` ${result.hovered.name}` : ' (empty)'}`);
    for (const line of result.hovered.tooltip || []) lines.push(`  | ${plain(line)}`);
  } else if (result.tooltipText?.length) {
    lines.push('tooltip:');
    for (const line of result.tooltipText) lines.push(`  | ${plain(line)}`);
  }
  return lines.map(printable).join('\n');
}

// screen --brief: title, widget labels and the container's named items, one per line.
export function briefScreen(screen) {
  if (!screen.class) return 'no screen';
  const lines = [`${plain(screen.title) || '(no title)'}  (${simpleClass(screen.class)})`];
  const labels = (screen.widgets || []).map(widget => plain(widget.label)).filter(Boolean);
  if (labels.length) lines.push(`widgets: ${labels.join(' | ')}`);
  const filled = (screen.slots || []).filter(slot => slot.item);
  const container = filled.filter(slot => !slot.player);
  // the player's own inventory screen has nothing else to show
  const own = container.length ? container : filled;
  const groups = new Map();
  for (const slot of own) {
    const name = plain(slot.item.name);
    // unnamed filler (panes named " ") says nothing
    if (!name) continue;
    const key = `${name}${slot.item.count > 1 ? ` x${slot.item.count}` : ''}`;
    groups.set(key, [...(groups.get(key) || []), slot.index]);
  }
  for (const [name, indexes] of groups) lines.push(`${indexes.join(',').padStart(3)}  ${name}`);
  const hidden = filled.length - own.length;
  if (hidden) lines.push(`(${hidden} items in the player inventory not shown)`);
  return lines.map(printable).join('\n');
}

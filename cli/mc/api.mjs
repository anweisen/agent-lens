// mc <api command>: thin mapping of command lines onto the HTTP API of the lens mod (docs/api.md).
import fs from 'node:fs';
import path from 'node:path';
import { camel, splitArgs, typed as typedValue } from '../core/args.mjs';
import { printResult } from '../core/format.mjs';
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
  capture: { many: 'region' },
  frames: { many: 'region' },
  compose: {},
  record: { positionals: ['action'] },
};

const NESTED = ['hover', 'create', 'fixed', 'window'];
// never auto-typed: "42" stays a string
const STRINGS = new Set(['text', 'world', 'match', 'widget', 'key', 'out', 'before', 'after', 'server', 'label',
  'path']);
const FILES = ['out', 'before', 'after'];
// consumed by the CLI, never sent
const CLI_FLAGS = new Set(['json', 'restart', 'force', 'no-start', 'http-timeout']);

const typed = (key, raw) => typedValue(key, raw, STRINGS);

export function bodyFromArgs(name, argv) {
  const spec = COMMANDS[name];
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
        const mode = auth || defaultAuth(config);
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
      const result = await context.call(spec.method || 'POST', `/${name}`, body, { autoStart: !spec.noStart });
      return name === 'record' && body.action === 'stop' ? muxRecording(config, result) : result;
    },
  };
  return context;
}

// relative to the working directory, not to a scene's output directory; "~/" as in a shell
export const packPath = file => path.resolve(expandHome(file));

// The session server rate-limits logins ("Failed to log in: Status: 429"), typically right after a client start.
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
      if (!(error instanceof ApiError) || !/Status: 429/.test(error.message) || attempt >= LOGIN_RETRIES) throw error;
      const pause = loginRetryMs();
      context.log(`login rate-limited (429), retry ${attempt + 1} of ${LOGIN_RETRIES} in ${pause / 1000} s`);
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
  printResult(await context.run(name, body), cli.json);
  return 0;
}

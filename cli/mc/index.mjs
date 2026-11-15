// mc: the Minecraft client. Lifecycle commands are handled here, everything else maps onto the mod's HTTP API.
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig } from '../core/config.mjs';
import { formatResult } from '../core/format.mjs';
import { APP } from '../core/paths.mjs';
import { logFile, readClient } from '../core/state.mjs';
import { MC_USAGE } from './help.mjs';
import { install, resolveVersion } from './install.mjs';
import { buildCommand, start, status, stop, waitReady } from './launcher.mjs';
import { defaultAuth } from './servers.mjs';

function applyOverrides(config, values) {
  if (values.backend) config.backend = values.backend;
  if (values.width) config.width = Number(values.width);
  if (values.height) config.height = Number(values.height);
  if (values.username) config.username = values.username;
  for (const pair of values.env || []) {
    const split = pair.indexOf('=');
    if (split < 1) throw new Error(`--env expects KEY=VALUE, got ${pair}`);
    const value = pair.slice(split + 1);
    if (value === '') delete config.env[pair.slice(0, split)];
    else config.env[pair.slice(0, split)] = value;
  }
  config.jvmArgs.push(...(values['jvm-arg'] || []));
}

function authMode(config, value) {
  const mode = value || defaultAuth(config);
  if (mode !== 'offline' && mode !== 'microsoft') throw new Error('--auth expects offline or microsoft');
  return mode;
}

const LAUNCHER_COMMANDS = ['install', 'start', 'stop', 'status', 'logs', 'command', 'login'];

// services: what mc may use from other modules, handed in by main.mjs (webCompare for "scene compare --pixel-diff")
export async function runMc(argv, services = {}) {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(MC_USAGE);
    return command ? 0 : 2;
  }
  if (!LAUNCHER_COMMANDS.includes(command)) {
    const config = loadConfig();
    if (command === 'scene') return (await import('./scene.mjs')).runScene(config, rest, services);
    const api = await import('./api.mjs');
    if (command !== 'api' && !api.COMMANDS[command]) {
      process.stderr.write(`${APP}: unknown command "mc ${command}", see "${APP} help mc"\n`);
      return 2;
    }
    return api.runApiCommand(config, command, rest);
  }

  const { values } = parseArgs({
    args: rest,
    options: {
      verify: { type: 'boolean' },
      wait: { type: 'boolean' },
      json: { type: 'boolean' },
      full: { type: 'boolean' },
      restart: { type: 'boolean' },
      auth: { type: 'string' },
      backend: { type: 'string' },
      width: { type: 'string' },
      height: { type: 'string' },
      username: { type: 'string' },
      env: { type: 'string', multiple: true },
      'jvm-arg': { type: 'string', multiple: true },
      lines: { type: 'string', short: 'n', default: '40' },
    },
  });
  const config = loadConfig();
  applyOverrides(config, values);

  switch (command) {
    case 'install': {
      await install(config, { verify: values.verify });
      console.log(`installed Minecraft ${config.minecraft} with Fabric Loader ${config.fabricLoader}`);
      return 0;
    }
    case 'start': {
      const began = Date.now();
      const mode = authMode(config, values.auth);
      const running = readClient();
      if (running && (running.auth || 'offline') !== mode) {
        if (!values.restart) {
          throw new Error(`already running with session "${running.auth || 'offline'}" (pid ${running.pid}); `
            + 'add --restart to replace it');
        }
        await stop();
      }
      const needLogin = mode === 'microsoft' && !readClient();
      const session = needLogin ? await (await import('./auth.mjs')).getSession(config) : undefined;
      const client = await start(config, { session });
      if (client.alreadyRunning) console.log(`already running, pid ${client.pid}`);
      else console.log(`started, pid ${client.pid}, ${client.auth} session as ${client.username}, log ${client.log}`);
      if (values.wait) {
        const ready = await waitReady(config);
        const what = ready.signal === 'mod' ? `lens API on port ${ready.port}` : 'resources loaded';
        console.log(`ready after ${((Date.now() - began) / 1000).toFixed(1)} s (${what})`);
      }
      return 0;
    }
    case 'stop': {
      const result = await stop();
      console.log(result.wasRunning ? `stopped pid ${result.pid}${result.forced ? ' (SIGKILL)' : ''}` : 'not running');
      return 0;
    }
    case 'status': {
      const result = status();
      const api = result.running ? await (await import('./api.mjs')).peekStatus() : null;
      if (values.json) console.log(JSON.stringify({ ...result, api }, null, 2));
      else if (!result.running) console.log('not running');
      else {
        console.log(`running, pid ${result.pid}, since ${result.startedAt}, rss ${result.rssMb} MB, `
          + `${result.auth} session as ${result.username ?? config.username}`);
        if (!api) console.log('api: not up (still starting, or no lens mod)');
        else if (api.error) console.log(`api: ${api.error}`);
        else console.log(formatResult(api));
      }
      return result.running ? 0 : 1;
    }
    case 'logs': {
      if (!fs.existsSync(logFile)) {
        console.log('no log yet');
        return 1;
      }
      const lines = fs.readFileSync(logFile, 'utf8').trimEnd().split('\n');
      const tail = lines.slice(-Number(values.lines));
      const cut = line => (values.full || line.length <= 300 ? line : `${line.slice(0, 300)} ...`);
      console.log(tail.map(cut).join('\n'));
      return 0;
    }
    case 'command': {
      // Never a real login here: the Microsoft variant is printed with placeholders.
      const session = authMode(config, values.auth) === 'microsoft'
        ? { name: config.account.name || '<profile name>', uuid: '<profile uuid>', accessToken: '<redacted>' }
        : undefined;
      const { java, args } = buildCommand(config, await resolveVersion(config, { offline: true }), { session });
      console.log([java, ...args].join('\n'));
      return 0;
    }
    case 'login': {
      const { getSession } = await import('./auth.mjs');
      const session = await getSession(config, {
        interactive: true,
        onCode: code => console.log(`open ${code.verification_uri} and enter the code ${code.user_code} `
          + `(valid ${Math.round(code.expires_in / 60)} min); waiting ...`),
      });
      console.log(`logged in as ${session.name} (${session.uuid})`);
      return 0;
    }
  }
  return 2;
}

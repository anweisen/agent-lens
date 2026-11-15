// Starts, stops and watches the client process.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { APP, PROP_PREFIX, ensureStateDir, paths } from '../core/paths.mjs';
import {
  clearClient, clearStale, logFile, modStateFile, readClient, readModState, withStartLock, writeClient,
} from '../core/state.mjs';
import { install, rulesAllow, resolveVersion } from './install.mjs';
import { findJava } from './java.mjs';
import { allowList } from './servers.mjs';

const LAUNCHER_NAME = APP;
const LAUNCHER_VERSION = '0.1';

export function offlineUuid(username) {
  const bytes = crypto.createHash('md5').update(`OfflinePlayer:${username}`).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x30;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes.toString('hex');
}

function expandArgs(list, values, features) {
  const out = [];
  for (const entry of list) {
    if (typeof entry !== 'string' && !rulesAllow(entry.rules, features)) continue;
    const raw = typeof entry === 'string' ? [entry] : [].concat(entry.value);
    for (const arg of raw) out.push(arg.replace(/\$\{(\w+)\}/g, (_, key) => values[key] ?? ''));
  }
  return out;
}

// "--clientId ''" style pairs are dropped: an offline session has no client id or xuid.
function dropEmptyOptions(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && args[i + 1] === '') i++;
    else out.push(args[i]);
  }
  return out;
}

// session: {name, uuid, accessToken} of a Microsoft login; without it the client runs offline.
// The access token only ever goes into the returned argument list.
export function buildCommand(config, { version, fabric, libraries, client }, { session, java } = {}) {
  const natives = config.dirs.natives;
  const values = {
    auth_player_name: session ? session.name : config.username,
    version_name: fabric.id,
    game_directory: config.dirs.game,
    assets_root: config.dirs.assets,
    assets_index_name: version.assetIndex.id,
    auth_uuid: session ? session.uuid : offlineUuid(config.username),
    auth_access_token: session ? session.accessToken : '0',
    clientid: '',
    auth_xuid: '',
    version_type: version.type,
    resolution_width: String(config.width),
    resolution_height: String(config.height),
    natives_directory: natives,
    launcher_name: LAUNCHER_NAME,
    launcher_version: LAUNCHER_VERSION,
    classpath: [...libraries.map(library => library.file), client.file].join(path.delimiter),
  };
  const features = { has_custom_resolution: true };
  const jvm = [
    `-Xmx${config.xmx}`,
    '-Xms512M',
    `-XX:ActiveProcessorCount=${config.cpus}`,
    '-XX:+UseCompactObjectHeaders',
    `-D${PROP_PREFIX}.port=${config.port}`,
    `-D${PROP_PREFIX}.stateFile=${modStateFile}`,
    `-D${PROP_PREFIX}.idleMinutes=${config.idleMinutes}`,
    ...(recordsAudio(config) ? [`-D${PROP_PREFIX}.audioFile=${audioLink}`] : []),
    `-D${PROP_PREFIX}.allow=${allowList(config, session ? 'microsoft' : 'offline').join(',')}`,
    ...config.jvmArgs,
    ...(fabric.arguments?.jvm || []),
    ...expandArgs(version.arguments.jvm, values, features),
  ];
  const game = dropEmptyOptions([
    ...expandArgs(version.arguments.game, values, features),
    ...(fabric.arguments?.game || []),
    // An argument, not options.txt: after an unclean shutdown the client rewrites preferredGraphicsBackend.
    '--graphicsBackend', config.backend,
    // No session, profile key or telemetry requests with the dummy token.
    ...(session ? [] : ['--offlineDeveloperMode']),
    ...config.gameArgs,
  ]);
  return { java: java ?? findJava(config, version).file, args: [...jvm, fabric.mainClass, ...game] };
}

// Only keys that are missing are added, so settings changed in-game or by the mod survive a restart.
// Keys the launcher owns (window, sound, frame limit) are always rewritten.
export function writeOptions(config) {
  const file = path.join(config.dirs.game, 'options.txt');
  const owned = {
    maxFps: config.maxFps,
    enableVsync: false,
    fullscreen: false,
    guiScale: config.guiScale,
    // audible for "mc record"; no background music in a recording
    soundCategory_master: '1.0',
    soundCategory_music: '0.0',
    pauseOnLostFocus: false,
    narrator: 0,
    onboardAccessibility: false,
    tutorialStep: 'none',
    skipMultiplayerWarning: true,
    joinedFirstServer: true,
    realmsNotifications: false,
    telemetryOptInExtra: false,
    bobView: false,
    hideSplashTexts: true,
    // vanilla defaults: the blurred world behind a menu or dialog and the vignette are part of the look
    menuBackgroundBlurriness: 5,
    vignette: true,
    panoramaScrollSpeed: '0.0',
    overrideWidth: config.width,
    overrideHeight: config.height,
  };
  const options = new Map();
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const split = line.indexOf(':');
      if (split > 0) options.set(line.slice(0, split), line.slice(split + 1));
    }
  }
  for (const [key, value] of Object.entries(owned)) options.set(key, String(value));
  fs.mkdirSync(config.dirs.game, { recursive: true });
  fs.writeFileSync(file, [...options].map(([key, value]) => `${key}:${value}`).join('\n') + '\n');
}

// "mc record": OpenAL Soft writes its mix to a WAV file instead of a sound card. The file is a symlink to /dev/null
// that the mod points at a real file while it records, so nothing is written (and no restart is needed) otherwise.
const audioLink = path.join(paths.state, 'audio.wav');
const audioConf = path.join(paths.state, 'alsoft.conf');
const recordsAudio = config => config.env.ALSOFT_DRIVERS === 'wave';

function prepareAudio(config) {
  if (!recordsAudio(config)) return {};
  fs.rmSync(audioLink, { force: true });
  fs.symlinkSync('/dev/null', audioLink);
  // a short mixer period places a sound to about 5 ms; HRTF off keeps the mix plain stereo
  fs.writeFileSync(audioConf, '[general]\nfrequency=48000\nchannels=stereo\nsample-type=int16\nperiod_size=256\n'
    + `hrtf=false\n[wave]\nfile=${audioLink}\n`);
  return { ALSOFT_CONF: audioConf };
}

export async function start(config, { log = console.log, session } = {}) {
  return withStartLock(async () => {
    const running = readClient();
    if (running) return { ...running, alreadyRunning: true };

    const resolved = await resolveVersion(config, { offline: true });
    const missing = [resolved.client, ...resolved.libraries].filter(item => !fs.existsSync(item.file));
    if (missing.length || !fs.existsSync(path.join(config.dirs.assets, 'indexes'))) {
      log('files missing, running install first');
      await install(config, { log });
    }
    const javaFile = findJava(config, resolved.version).file;

    fs.mkdirSync(path.join(config.dirs.game, 'mods'), { recursive: true });
    fs.mkdirSync(config.dirs.natives, { recursive: true });
    writeOptions(config);

    const { java, args } = buildCommand(config, resolved, { session, java: javaFile });
    ensureStateDir();
    clearClient();
    const audioEnv = prepareAudio(config);
    const out = fs.openSync(logFile, 'w');
    const child = spawn(java, args, {
      cwd: config.dirs.game,
      env: { ...process.env, ...audioEnv, ...config.env },
      detached: true,
      stdio: ['ignore', out, out],
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
    fs.closeSync(out);
    return writeClient({ pid: child.pid, startedAt: new Date().toISOString(), log: logFile, backend: config.backend,
      width: config.width, height: config.height, env: config.env, auth: session ? 'microsoft' : 'offline',
      username: session ? session.name : config.username, gameDir: config.dirs.game });
  });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1][0] !== 'Z';
  } catch {
    return false;
  }
}

export async function stop({ timeoutMs = 10_000 } = {}) {
  const client = readClient();
  if (!client) {
    clearClient();
    return { wasRunning: false };
  }
  // detached: true made the client a process group leader, so this also takes helper processes with it
  const signal = name => {
    try {
      process.kill(-client.pid, name);
    } catch {}
  };
  signal('SIGTERM');
  const deadline = Date.now() + timeoutMs;
  while (alive(client.pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  let forced = false;
  if (alive(client.pid)) {
    forced = true;
    signal('SIGKILL');
    while (alive(client.pid)) await new Promise(resolve => setTimeout(resolve, 100));
  }
  clearClient();
  return { wasRunning: true, pid: client.pid, forced };
}

export function status() {
  const client = readClient();
  if (!client) {
    // left behind by an idle shutdown, /quit or a crash
    clearStale();
    return { running: false };
  }
  const stat = fs.readFileSync(`/proc/${client.pid}/status`, 'utf8');
  const rssKb = Number(/VmRSS:\s+(\d+)/.exec(stat)?.[1] || 0);
  return { running: true, ...client, rssMb: Math.round(rssKb / 1024) };
}

// Vanilla logs nothing when the title screen appears. Without the lens mod the best log signal is the end of the
// first resource reload (the title screen follows about 1.5 s later); with the mod, its state file is exact.
const RESOURCES_LOADED = /Sound engine started[\s\S]*Created: \d+x\d+x\d+ minecraft:textures\/atlas\//;

export function hasLensMod(config) {
  const mods = path.join(config.dirs.game, 'mods');
  return fs.existsSync(mods) && fs.readdirSync(mods).some(name => /lens.*\.jar$/.test(name));
}

const LOG_NOISE = /Failed to set window icon|Error while loading the narrator|Failed to retrieve profile key pair/;
const LOG_PROBLEM = new RegExp(['/(ERROR|FATAL)\\]', '\\b[\\w.$]*(Exception|Error)\\b', '^Caused by:', '[Mm]ixin',
  'crash report', 'Unrecognized|Could not|Unable to|Incompatible mods'].join('|'));

// Why the client died: the exception, mixin and error lines of the log (stack frames left out), or its last lines.
export function crashReason({ maxLines = 14 } = {}) {
  if (!fs.existsSync(logFile)) return '';
  const lines = fs.readFileSync(logFile, 'utf8').split('\n').map(line => line.trimEnd()).filter(Boolean);
  const cut = line => (line.length > 300 ? `${line.slice(0, 300)} ...` : line);
  const problems = [...new Set(lines.filter(line => LOG_PROBLEM.test(line) && !LOG_NOISE.test(line)
    && !/^\s+at /.test(line)).map(cut))];
  const shown = problems.length ? problems.slice(-maxLines) : lines.slice(-8).map(cut);
  return shown.map(line => `  ${line.trim()}`).join('\n');
}

function exited() {
  clearStale();
  const reason = crashReason();
  return new Error(`client exited${reason ? `, from the log:\n${reason}\n ` : ','} full log: ${APP} mc logs -n 100`);
}

export function waitReady(config, { timeoutMs = 180_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const needMod = hasLensMod(config);
  return new Promise((resolve, reject) => {
    const check = () => {
      const mod = readModState();
      if (mod) return resolve({ signal: 'mod', ...mod });
      if (!needMod && fs.existsSync(logFile) && RESOURCES_LOADED.test(fs.readFileSync(logFile, 'utf8'))) {
        return resolve({ signal: 'log' });
      }
      if (!readClient()) return reject(exited());
      if (Date.now() > deadline) return reject(new Error('timed out waiting for the client to become ready'));
      setTimeout(check, 250);
    };
    check();
  });
}

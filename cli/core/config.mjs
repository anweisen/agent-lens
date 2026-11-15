// The user config: one JSON file, every key optional. Defaults are neutral: no servers, no forges, no account
// name, no machine paths. docs/config.md is the reference.
import fs from 'node:fs';
import path from 'node:path';
import { APP, envVar, expandHome, paths } from './paths.mjs';

// The only place versions are pinned.
export const defaults = {
  minecraft: '26.3',
  fabricLoader: '0.20.1',
  // java binary; null = JAVA_HOME, then java on PATH, then ~/.jdks
  java: null,
  // ffmpeg binary for the MP4 of "mc record --video"; null = ffmpeg on PATH (without one, frames and WAV stay)
  ffmpeg: null,
  // player name of an offline session
  username: 'agent_lens',
  width: 1280,
  height: 720,
  maxFps: 30,
  guiScale: 2,
  xmx: '3G',
  cpus: 4,
  // 'opengl' or 'vulkan', passed as --graphicsBackend
  backend: 'opengl',
  // session of a client started without an explicit mode: true = offline (--offlineDeveloperMode, no requests to
  // the Mojang services), false = Microsoft account
  offline: true,
  env: {
    // SDL3 without a display server: the offscreen driver creates an EGL pbuffer on the DRM render node
    SDL_VIDEODRIVER: 'offscreen',
    // OpenAL Soft without a sound card: 'wave' mixes into a file (/dev/null unless "mc record" runs), 'null'
    // discards the mix and disables recording
    ALSOFT_DRIVERS: 'wave',
  },
  // read by the lens mod: API port (0 = ephemeral), idle shutdown
  port: 0,
  idleMinutes: 10,
  // The only servers a client may join: name -> {host, port, auth, resourcePack?}. Host and port are both
  // mandatory: a bare host would follow the SRV record, which can point anywhere, production included.
  servers: {},
  account: {
    // expected profile name; null accepts whatever account the login cache holds
    name: null,
    // prismarine-auth token cache; null = <config dir>/auth
    cacheDir: null,
    // the Authflow user name the cache file names are hashed from
    cacheKey: APP,
    // overrides for the Authflow options {flow, authTitle, deviceType}
    authflow: {},
    // processes that use the same account: [{name, cwd, command?, unlessEnv?}]
    conflicts: [],
  },
  web: {
    // extra environment and global arguments for the docker CLI (a remote daemon, a context)
    docker: { env: {}, args: [] },
    // directories the Docker daemon can bind-mount at the same path; null = the home directory
    mountRoot: null,
  },
  // name -> {type, api, auth, ...}
  forges: {},
  jvmArgs: [],
  gameArgs: [],
};

const AUTH_MODES = ['offline', 'microsoft'];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function validateServers(servers, problems) {
  if (!isObject(servers)) {
    problems.push('servers must be an object of name -> {host, port, auth}');
    return;
  }
  for (const [name, server] of Object.entries(servers)) {
    if (!/^[\w.-]+$/.test(name)) problems.push(`server name "${name}" must match [A-Za-z0-9_.-]+`);
    if (typeof server?.host !== 'string' || !server.host || /[\s:,]/.test(server.host)) {
      problems.push(`servers.${name}.host must be a host name or IPv4 address without port`);
    }
    if (!Number.isInteger(server?.port) || server.port < 1 || server.port > 65535) {
      problems.push(`servers.${name}.port must be an explicit port number`);
    }
    if (!AUTH_MODES.includes(server?.auth)) problems.push(`servers.${name}.auth must be offline or microsoft`);
    if (server?.resourcePack !== undefined && typeof server.resourcePack !== 'string') {
      problems.push(`servers.${name}.resourcePack must be the path of a pack directory or zip`);
    }
  }
}

function validateAccount(account, problems) {
  if (!isObject(account.authflow)) problems.push('account.authflow must be an object');
  if (!Array.isArray(account.conflicts)) {
    problems.push('account.conflicts must be a list of {name, cwd, command?, unlessEnv?}');
    return;
  }
  account.conflicts.forEach((entry, index) => {
    const where = `account.conflicts[${index}]`;
    if (typeof entry?.name !== 'string' || !entry.name) problems.push(`${where}.name must be a string`);
    if (typeof entry?.cwd !== 'string' || !entry.cwd) problems.push(`${where}.cwd must be a directory`);
    if (entry?.unlessEnv !== undefined && !/^[^=]+=/.test(entry.unlessEnv)) {
      problems.push(`${where}.unlessEnv must be "KEY=value"`);
    }
  });
}

function validateForges(forges, problems) {
  if (!isObject(forges)) {
    problems.push('forges must be an object of name -> {type, api, auth}');
    return;
  }
  for (const [name, forge] of Object.entries(forges)) {
    if (typeof forge?.type !== 'string') problems.push(`forges.${name}.type is missing`);
    if (forge?.api !== undefined && !/^https?:\/\//.test(forge.api)) {
      problems.push(`forges.${name}.api must be an http(s) URL`);
    }
    if (forge?.auth !== undefined && typeof forge.auth?.type !== 'string') {
      problems.push(`forges.${name}.auth must be {type: "none" | "token-env" | "gh"}`);
    }
  }
}

export function validateConfig(config) {
  const problems = [];
  if (typeof config.offline !== 'boolean') problems.push('offline must be a boolean');
  if (!['opengl', 'vulkan'].includes(config.backend)) problems.push('backend must be opengl or vulkan');
  for (const key of ['width', 'height', 'maxFps', 'guiScale', 'cpus', 'idleMinutes', 'port']) {
    if (!Number.isFinite(config[key])) problems.push(`${key} must be a number`);
  }
  if (config.java !== null && typeof config.java !== 'string') problems.push('java must be the path of a java binary');
  if (config.ffmpeg !== null && typeof config.ffmpeg !== 'string') {
    problems.push('ffmpeg must be the path of an ffmpeg binary');
  }
  validateServers(config.servers, problems);
  validateAccount(config.account, problems);
  validateForges(config.forges, problems);
  if (!isObject(config.web.docker.env)) problems.push('web.docker.env must be an object');
  if (!Array.isArray(config.web.docker.args)) problems.push('web.docker.args must be a list');
  return problems;
}

// One level deep: user keys win, a key set to null is removed.
function mergeMap(base, user) {
  const merged = { ...base, ...(isObject(user) ? user : {}) };
  for (const [key, value] of Object.entries(merged)) if (value === null) delete merged[key];
  return merged;
}

export function loadConfig() {
  let user = {};
  if (fs.existsSync(paths.config)) {
    try {
      user = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
    } catch (error) {
      throw new Error(`${paths.config}: ${error.message}`);
    }
    if (!isObject(user)) throw new Error(`${paths.config}: expected a JSON object`);
  }
  const config = { ...defaults, ...user };
  config.env = mergeMap(defaults.env, user.env);
  config.servers = mergeMap(defaults.servers, user.servers);
  config.forges = mergeMap(defaults.forges, user.forges);
  config.account = { ...defaults.account, ...(isObject(user.account) ? user.account : {}) };
  const web = isObject(user.web) ? user.web : {};
  const docker = isObject(web.docker) ? web.docker : {};
  config.web = { ...defaults.web, ...web, docker: { ...defaults.web.docker, ...docker } };

  const problems = validateConfig(config);
  if (problems.length) throw new Error(`invalid config ${paths.config}: ${problems.join('; ')}`);

  if (config.java) config.java = expandHome(config.java);
  config.account.cacheDir = config.account.cacheDir
    ? path.resolve(expandHome(config.account.cacheDir))
    : path.join(paths.configDir, 'auth');
  config.account.conflicts = config.account.conflicts
    .map(entry => ({ ...entry, cwd: path.resolve(expandHome(entry.cwd)) }));
  const roots = config.web.mountRoot === null ? [paths.home] : [].concat(config.web.mountRoot);
  config.web.mountRoots = roots.map(root => path.resolve(expandHome(root)));
  config.dirs = {
    libraries: path.join(paths.cache, 'libraries'),
    assets: path.join(paths.cache, 'assets'),
    versions: path.join(paths.cache, 'versions'),
    natives: path.join(paths.cache, 'natives', config.minecraft),
    // <PREFIX>_GAME_DIR: own worlds, mods and options for a second client instance
    game: envVar('GAME_DIR') ? path.resolve(envVar('GAME_DIR')) : path.join(paths.cache, 'game'),
    node: path.join(paths.cache, 'node'),
    web: path.join(paths.cache, 'web'),
  };
  return config;
}

export const configSource = () => (fs.existsSync(paths.config) ? paths.config : `defaults (no ${paths.config})`);

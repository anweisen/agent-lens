// Where things live. Nothing here depends on the config file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const APP = 'agent-lens';
// prefix of the environment variables and of the JVM properties read by the mod
export const ENV_PREFIX = 'AGENT_LENS';
export const PROP_PREFIX = 'agentlens';

const env = process.env;
const home = os.homedir();

export const envVar = name => env[`${ENV_PREFIX}_${name}`];

// "~" and "~/x" as in a shell; everything else is resolved against the working directory
export function expandHome(file) {
  if (file === '~') return home;
  return file.startsWith('~/') ? path.join(home, file.slice(2)) : file;
}

export const inside = (dir, file) => file === dir || file.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

function tmpfsShm() {
  try {
    const mounted = fs.readFileSync('/proc/mounts', 'utf8').split('\n')
      .some(line => /^\S+ \/dev\/shm tmpfs /.test(line));
    if (!mounted) return false;
    fs.accessSync('/dev/shm', fs.constants.W_OK | fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const persistentState = path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), APP);

// Runtime state (pid, port, start lock) is small and worthless after a reboot: it goes to memory when there is a
// place for it. <PREFIX>_STATE_DIR selects another directory and with it a second, independent client instance.
function stateDir() {
  if (envVar('STATE_DIR')) return path.resolve(envVar('STATE_DIR'));
  if (env.XDG_RUNTIME_DIR) return path.join(env.XDG_RUNTIME_DIR, APP);
  if (tmpfsShm()) return `/dev/shm/${APP}-${os.userInfo().uid}`;
  return persistentState;
}

const configDir = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), APP);

export const paths = {
  home,
  configDir,
  config: envVar('CONFIG') ? path.resolve(envVar('CONFIG')) : path.join(configDir, 'config.json'),
  cache: envVar('CACHE')
    ? path.resolve(envVar('CACHE'))
    : path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), APP),
  state: stateDir(),
  // the client log must survive a crash and a reboot, so it stays on disk
  logs: envVar('STATE_DIR') ? path.resolve(envVar('STATE_DIR')) : persistentState,
};

export function ensureStateDir() {
  fs.mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.logs, { recursive: true });
}

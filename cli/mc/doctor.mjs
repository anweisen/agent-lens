// doctor checks of the Minecraft module.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { APP, paths } from '../core/paths.mjs';
import { onPath } from '../core/proc.mjs';
import { cacheStatus } from './auth.mjs';
import { findConflicts } from './conflicts.mjs';
import { resolveVersion } from './install.mjs';
import { findJava } from './java.mjs';
import { hasLensMod, status } from './launcher.mjs';
import { describeServers } from './servers.mjs';
import { findFfmpeg } from './video.mjs';

function renderNode() {
  try {
    const nodes = fs.readdirSync('/dev/dri').filter(name => name.startsWith('renderD')).sort();
    return nodes.map(name => `/dev/dri/${name}`).find(file => {
      try {
        fs.accessSync(file, fs.constants.R_OK | fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    });
  } catch {
    return undefined;
  }
}

function gpu(add) {
  const node = renderNode();
  const eglinfo = onPath('eglinfo');
  let renderer = '';
  if (eglinfo) {
    const out = spawnSync(eglinfo, ['-B'], { encoding: 'utf8', timeout: 20_000 }).stdout || '';
    renderer = /renderer(?: string)?:\s*(.+)/.exec(out)?.[1]?.trim() || '';
  }
  const egl = renderer ? `; EGL renderer: ${renderer}` : '';
  if (node) add('ok', 'gpu', `${node} accessible${egl}`);
  else {
    add('warn', 'gpu', `no accessible render node under /dev/dri: the client needs software GL (Mesa llvmpipe)${egl}`);
  }
}

export async function mcChecks(config, add) {
  const servers = describeServers(config);
  add('ok', 'servers', servers.length
    ? servers.join(', ')
    : `none configured (singleplayer only), see "servers" in ${paths.config}`);

  let version;
  try {
    const resolved = await resolveVersion(config, { offline: true });
    version = resolved.version;
    const missing = [resolved.client, ...resolved.libraries].filter(item => !fs.existsSync(item.file)).length;
    const assets = fs.existsSync(path.join(config.dirs.assets, 'indexes', `${version.assetIndex.id}.json`));
    if (missing || !assets) {
      add('warn', 'install', `${missing} files missing${assets ? '' : ', no asset index'}: run "${APP} mc install"`);
    } else {
      add('ok', 'install', `Minecraft ${config.minecraft}, Fabric Loader ${config.fabricLoader} in ${paths.cache}`);
    }
  } catch (error) {
    add('warn', 'install', `not installed (${error.message}): run "${APP} mc install"`);
  }

  try {
    const java = findJava(config, version);
    const needed = version?.javaVersion?.majorVersion;
    add('ok', 'java', `${java.file} (${java.source}): Java ${java.major}${needed ? `, the game needs ${needed}` : ''}`);
  } catch (error) {
    add('FAIL', 'java', error.message);
  }

  gpu(add);

  const mods = path.join(config.dirs.game, 'mods');
  if (hasLensMod(config)) {
    const jars = fs.readdirSync(mods).filter(name => /lens.*\.jar$/.test(name));
    add('ok', 'mod', jars.map(name => path.join(mods, name)).join(', '));
  } else add('FAIL', 'mod', `no lens*.jar in ${mods}: run mod/install.sh from the repository`);

  const ffmpeg = findFfmpeg(config);
  add('ok', 'ffmpeg', ffmpeg ?? 'not found (optional: "mc record --video" then keeps frames + WAV instead of an MP4)');

  const client = status();
  add('ok', 'client', client.running
    ? `running, pid ${client.pid}, ${client.auth} session, rss ${client.rssMb} MB`
    : 'not running (starts on demand)');

  const cache = cacheStatus(config);
  const online = Object.values(config.servers).some(server => server.auth === 'microsoft') || !config.offline;
  const expected = config.account.name ? `expected account ${config.account.name}` : 'any account';
  if (!cache.present) {
    add(online ? 'warn' : 'ok', 'account', `no login cache in ${cache.dir}`
      + (online ? `: online servers need "${APP} mc login"` : ' (not needed: no online server configured)'));
  } else if (!cache.hasRefreshToken) {
    add('warn', 'account', `login cache in ${cache.dir} has no refresh token: "${APP} mc login"`);
  } else {
    const token = cache.minecraftTokenValid
      ? `Minecraft token valid until ${cache.minecraftTokenExpires}`
      : 'Minecraft token expired, refreshed on next use';
    add('ok', 'account', `login cache ${cache.dir} (${expected}); ${token}`);
  }

  if (config.account.conflicts.length) {
    const running = findConflicts(config);
    const names = config.account.conflicts.map(entry => entry.name).join(', ');
    add(running.length ? 'warn' : 'ok', 'conflict', running.length
      ? `${running.map(entry => `${entry.name} (pid ${entry.pid})`).join(', ')} running: online connects are refused`
      : `${names}: not running`);
  }
}

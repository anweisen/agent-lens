// The two npm dependencies are pinned in a package.json inside the repo and installed on first use into the cache,
// so the repo itself never holds a node_modules directory.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { APP } from './paths.mjs';

export function pinnedVersion(pinFile, name) {
  return JSON.parse(fs.readFileSync(pinFile, 'utf8')).dependencies[name];
}

// Returns the directory to require the package from.
export function ensurePinned({ pinFile, name, dir, env = {} }) {
  const version = pinnedVersion(pinFile, name);
  const installed = path.join(dir, 'node_modules', name, 'package.json');
  try {
    if (JSON.parse(fs.readFileSync(installed, 'utf8')).version === version) return dir;
  } catch {
    // not installed yet
  }
  console.error(`${APP}: installing ${name}@${version} into ${dir} (first use)`);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(pinFile, path.join(dir, 'package.json'));
  const nodeDir = path.dirname(process.execPath);
  const result = spawnSync(path.join(nodeDir, 'npm'), ['install', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: dir,
    stdio: ['ignore', 2, 2],
    env: { ...process.env, PATH: `${nodeDir}:${process.env.PATH}`, ...env },
  });
  if (result.status !== 0) {
    throw new Error(`npm install ${name} failed (exit ${result.status ?? result.error?.message})`);
  }
  return dir;
}

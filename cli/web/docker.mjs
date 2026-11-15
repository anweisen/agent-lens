// One browser container per command: `docker run --rm`, job on stdin, result on stdout, gone when it returns.
// Directories the Docker daemon can see are mounted as they are; anything else is staged through the cache.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePinned, pinnedVersion } from '../core/npm.mjs';
import { APP, inside } from '../core/paths.mjs';

// the scripts that run inside the container
const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const PIN_FILE = path.join(SCRIPTS, 'package.json');
export const PLAYWRIGHT_VERSION = pinnedVersion(PIN_FILE, 'playwright');
const IMAGE = `mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble`;

// The environment wins over the config, so a single call can still point somewhere else.
export function dockerCommand(config, args, opts = {}) {
  const env = { ...config.web.docker.env, ...process.env };
  return { cmd: 'docker', args: [...config.web.docker.args, ...args], opts: { ...opts, env } };
}

const visible = (config, dir) => config.web.mountRoots.some(root => inside(root, dir));

function sweep(jobs) {
  // leftovers of runs that were killed hard
  for (const name of fs.readdirSync(jobs)) {
    const dir = path.join(jobs, name);
    if (Date.now() - fs.statSync(dir).mtimeMs > 6 * 3600 * 1000) fs.rmSync(dir, { recursive: true, force: true });
  }
}

// fn gets a job context:
//   output(dir)        -> directory the container writes to; collect(files) moves staged files to their real place
//   input(dir, files)  -> directory the container reads these files from
//   run(job)           -> starts the container, returns its result
// common: {dns, hardTimeout, keep}
export async function withContainer(config, common, fn) {
  const cache = config.dirs.web;
  const modules = path.join(cache, 'pw');
  const jobs = path.join(cache, 'jobs');
  if (!visible(config, cache)) {
    throw new Error(`the cache directory ${cache} is not under a directory the Docker daemon can mount `
      + `(${config.web.mountRoots.join(', ')}); set web.mountRoot in the config`);
  }
  const mounts = new Map([[modules, 'ro']]);
  let stageDir = null;
  const stage = () => {
    if (!stageDir) {
      fs.mkdirSync(jobs, { recursive: true });
      sweep(jobs);
      stageDir = fs.mkdtempSync(path.join(jobs, `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-`));
      mounts.set(stageDir, 'rw');
    }
    return stageDir;
  };
  const cleanup = () => {
    if (!stageDir) return;
    if (common.keep) console.error(`${APP} web: job kept at ${stageDir}`);
    else fs.rmSync(stageDir, { recursive: true, force: true });
  };

  const context = {
    output(dir) {
      const real = path.resolve(dir);
      fs.mkdirSync(real, { recursive: true });
      if (visible(config, real) && !common.keep) {
        mounts.set(real, 'rw');
        return { dir: real, collect() {} };
      }
      const staged = path.join(stage(), 'out');
      fs.mkdirSync(staged, { recursive: true });
      return {
        dir: staged,
        collect(files) {
          for (const file of files) fs.copyFileSync(path.join(staged, file), path.join(real, file));
        },
      };
    },
    input(dir, files) {
      const real = path.resolve(dir);
      if (visible(config, real)) {
        if (!mounts.has(real)) mounts.set(real, 'ro');
        return real;
      }
      const staged = fs.mkdtempSync(path.join(stage(), 'in-'));
      for (const file of files) fs.copyFileSync(path.join(real, file), path.join(staged, file));
      return staged;
    },
    async run(job) {
      ensurePinned({
        pinFile: PIN_FILE, name: 'playwright', dir: modules, env: { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
      });
      let scripts = SCRIPTS;
      if (visible(config, SCRIPTS)) mounts.set(SCRIPTS, 'ro');
      else {
        scripts = path.join(stage(), 'scripts');
        fs.mkdirSync(scripts);
        for (const file of ['runner.mjs', 'compare.mjs']) {
          fs.copyFileSync(path.join(SCRIPTS, file), path.join(scripts, file));
        }
      }
      const input = JSON.stringify({ ...job, modules, hardTimeout: common.hardTimeout });
      if (common.keep) fs.writeFileSync(path.join(stage(), 'job.json'), input);
      const name = `${APP}-web-${process.pid}-${Date.now().toString(36)}`;
      const { uid, gid } = os.userInfo();
      const volumes = [...mounts].flatMap(([dir, mode]) => ['-v', `${dir}:${dir}${mode === 'ro' ? ':ro' : ''}`]);
      const args = ['run', '--rm', '-i', '--init', '--ipc=host', '--net=host', '--name', name,
        '--user', `${uid}:${gid}`, '-e', 'HOME=/tmp', ...common.dns.flatMap(server => ['--dns', server]),
        ...volumes, '-w', '/tmp', IMAGE,
        'node', path.join(scripts, 'runner.mjs')];
      const run = dockerCommand(config, args, { stdio: ['pipe', 'pipe', 2] });
      const child = spawn(run.cmd, run.args, run.opts);
      const onSignal = signal => {
        const kill = dockerCommand(config, ['kill', name], { stdio: 'ignore' });
        spawnSync(kill.cmd, kill.args, kill.opts);
        cleanup();
        process.exit(signal === 'SIGINT' ? 130 : 143);
      };
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
      const chunks = [];
      child.stdout.on('data', chunk => chunks.push(chunk));
      child.stdin.on('error', () => {});
      child.stdin.end(input);
      let code;
      try {
        code = await new Promise((resolve, reject) => {
          child.on('error', error => reject(new Error(error.code === 'ENOENT'
            ? 'docker is not on PATH: the web module needs the docker CLI and a reachable daemon'
            : `docker: ${error.message}`)));
          child.on('close', (exit, signal) => resolve(exit ?? (signal ? 128 : 1)));
        });
      } finally {
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
      }
      // the result is the last line of stdout
      const last = Buffer.concat(chunks).toString('utf8').trimEnd().split('\n').pop();
      try {
        const result = JSON.parse(last);
        if (result && typeof result === 'object') return result;
      } catch {
        // no result: the container died
      }
      throw new Error(`browser container failed (exit ${code}), see output above`);
    },
  };
  try {
    return await fn(context);
  } finally {
    cleanup();
  }
}

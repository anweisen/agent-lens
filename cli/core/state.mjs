import fs from 'node:fs';
import path from 'node:path';
import { ensureStateDir, paths } from './paths.mjs';

const clientFile = path.join(paths.state, 'client.json');
const lockFile = path.join(paths.state, 'start.lock');

// truncated at every client start, so it never holds more than one run
export const logFile = path.join(paths.logs, 'client.log');
// Written by the lens mod once its HTTP API is up: {port, pid, version}
export const modStateFile = path.join(paths.state, 'mod.json');

// Field 22 of /proc/<pid>/stat: start time in clock ticks. Guards against pid reuse after a reboot.
function procStartTime(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch {
    return null;
  }
}

export function readClient() {
  let client;
  try {
    client = JSON.parse(fs.readFileSync(clientFile, 'utf8'));
  } catch {
    return null;
  }
  const startTime = procStartTime(client.pid);
  if (!startTime || startTime !== client.procStartTime) return null;
  return client;
}

// The mod may be mid-write, and a file left by a client that died is not removed until the next start.
export function readModState() {
  try {
    const mod = JSON.parse(fs.readFileSync(modStateFile, 'utf8'));
    return Number.isInteger(mod.port) && mod.port > 0 ? mod : null;
  } catch {
    return null;
  }
}

export function writeClient(client) {
  ensureStateDir();
  const record = { ...client, procStartTime: procStartTime(client.pid) };
  fs.writeFileSync(clientFile, JSON.stringify(record, null, 2) + '\n');
  return record;
}

export function clearClient() {
  fs.rmSync(clientFile, { force: true });
  fs.rmSync(modStateFile, { force: true });
}

// Removes the state files of a client that is gone. A client.json that is missing or half-written while another
// CLI call is starting a client is left alone: only a parsed record of a dead process counts.
export function clearStale() {
  let client;
  try {
    client = JSON.parse(fs.readFileSync(clientFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && !fs.existsSync(lockFile)) fs.rmSync(modStateFile, { force: true });
    return;
  }
  const startTime = procStartTime(client.pid);
  if (!startTime || startTime !== client.procStartTime) clearClient();
}

// Two CLI calls racing on "start" must not both spawn a client: the loser waits, then finds the client running.
export async function withStartLock(fn) {
  ensureStateDir();
  const deadline = Date.now() + 60_000;
  let fd;
  while (fd === undefined) {
    try {
      fd = fs.openSync(lockFile, 'wx');
    } catch {
      // a lock older than any real start belongs to a CLI that was killed
      let stale = Date.now() > deadline;
      try {
        stale ||= Date.now() - fs.statSync(lockFile).mtimeMs > 120_000;
      } catch {}
      if (stale) fs.rmSync(lockFile, { force: true });
      else await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  try {
    return await fn();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lockFile, { force: true });
  }
}

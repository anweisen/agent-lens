// One account, one session: a second login with the same account kicks the first. The config can name other
// programs that use the account (account.conflicts); an online connect is refused while one of them runs.
import fs from 'node:fs';
import path from 'node:path';
import { inside } from '../core/paths.mjs';

// entry: {name, cwd, command?, unlessEnv?}. A process matches when its working directory or one of its arguments
// is inside cwd, its program name matches command (if given) and its environment lacks unlessEnv (if given).
function matches(entry, pid) {
  const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  if (!args.length) return null;
  if (entry.command && !new RegExp(`^(?:${entry.command})$`).test(path.basename(args[0]))) return null;
  const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
  if (!inside(entry.cwd, cwd) && !args.slice(1).some(arg => inside(entry.cwd, arg))) return null;
  if (entry.unlessEnv) {
    const environ = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
    if (environ.includes(entry.unlessEnv)) return null;
  }
  return { name: entry.name, pid: Number(pid), cwd, command: args.join(' ').slice(0, 120) };
}

export function findConflicts(config) {
  const entries = config.account.conflicts;
  if (!entries.length) return [];
  const found = [];
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    for (const entry of entries) {
      try {
        const hit = matches(entry, pid);
        if (hit) found.push(hit);
      } catch {
        // process gone or not ours
      }
    }
  }
  return found;
}

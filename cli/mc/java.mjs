// Picks the java binary: config.java, else JAVA_HOME, else java on PATH, else the JDKs under ~/.jdks. The game's
// version JSON says which major version it needs.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../core/paths.mjs';
import { onPath } from '../core/proc.mjs';

const major = text => {
  const match = /(\d+)(?:\.(\d+))?/.exec(text ?? '');
  if (!match) return null;
  // "1.8.0_392" is Java 8
  return match[1] === '1' && match[2] ? Number(match[2]) : Number(match[1]);
};

// The release file of a JDK answers without starting a JVM.
function javaMajor(file) {
  try {
    const release = fs.readFileSync(path.join(path.dirname(path.dirname(fs.realpathSync(file))), 'release'), 'utf8');
    const version = major(/^JAVA_VERSION="([^"]+)"/m.exec(release)?.[1]);
    if (version) return version;
  } catch {
    // a shim or a JRE without release file: ask the binary
  }
  const run = spawnSync(file, ['-version'], { encoding: 'utf8', timeout: 20_000 });
  if (run.status !== 0) return null;
  return major(/version "([^"]+)"/.exec(run.stderr || run.stdout || '')?.[1]);
}

function candidates(config) {
  if (config.java) return [{ source: 'config java', file: config.java }];
  const list = [];
  if (process.env.JAVA_HOME) list.push({ source: 'JAVA_HOME', file: path.join(process.env.JAVA_HOME, 'bin', 'java') });
  const found = onPath('java');
  if (found) list.push({ source: 'PATH', file: found });
  const jdks = path.join(paths.home, '.jdks');
  if (fs.existsSync(jdks)) {
    for (const name of fs.readdirSync(jdks).sort().reverse()) {
      list.push({ source: '~/.jdks', file: path.join(jdks, name, 'bin', 'java') });
    }
  }
  return list;
}

// version: the Minecraft version JSON (javaVersion.majorVersion). Returns {file, major, source}.
export function findJava(config, version) {
  const needed = version?.javaVersion?.majorVersion ?? 0;
  const seen = [];
  for (const candidate of candidates(config)) {
    if (!fs.existsSync(candidate.file)) {
      seen.push(`${candidate.file} (${candidate.source}): not found`);
      continue;
    }
    const found = javaMajor(candidate.file);
    if (found !== null && found >= needed) return { ...candidate, major: found };
    seen.push(`${candidate.file} (${candidate.source}): ${found === null ? 'does not run' : `Java ${found}`}`);
  }
  const what = seen.length ? `found ${seen.join('; ')}` : 'no JAVA_HOME, no java on PATH, nothing in ~/.jdks';
  throw new Error(`no Java ${needed || ''} or newer for the client: ${what}. `
    + 'Set "java" in the config to a java binary.');
}

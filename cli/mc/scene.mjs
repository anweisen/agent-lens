// mc scene run|compare: replay one JSON scene against two builds and pair up the captures.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { splitArgs } from '../core/args.mjs';
import { APP, expandHome, paths } from '../core/paths.mjs';
import { COMMANDS, bodyFromStep, createContext, plain } from './api.mjs';
import { resolveServer } from './servers.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const rectText = rect => (rect ? `${rect.x},${rect.y} ${rect.w}x${rect.h}` : '');

// {"include": "route.json"} is replaced by that scene's steps: relative to the including file, "~/" as in a shell.
function readScene(file, chain = []) {
  const resolved = path.resolve(file);
  if (chain.includes(resolved)) throw new Error(`${file}: include cycle (${[...chain, resolved].join(' -> ')})`);
  let scene;
  try {
    scene = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (error) {
    throw new Error(`${file}: ${error.message}`);
  }
  const own = Array.isArray(scene) ? scene : scene.steps;
  if (!Array.isArray(own) || !own.length) throw new Error(`${file}: expected a list of steps or {"steps": [...]}`);
  const steps = own.flatMap(step => {
    const keys = step && typeof step === 'object' ? Object.keys(step) : [];
    if (keys.length !== 1 || keys[0] !== 'include') return [step];
    if (typeof step.include !== 'string') throw new Error(`${file}: "include" takes a file name`);
    return readScene(path.resolve(path.dirname(resolved), expandHome(step.include)), [...chain, resolved]).steps;
  });
  return { scene, steps };
}

function loadScene(file) {
  const { scene, steps } = readScene(file);
  const names = new Set();
  steps.forEach((step, index) => {
    const keys = step && typeof step === 'object' ? Object.keys(step) : [];
    if (keys.length !== 1) throw new Error(`${file}: step ${index + 1} must be an object with exactly one key`);
    const [name] = keys;
    if (!COMMANDS[name] && name !== 'sleep' && name !== 'api') {
      const known = [...Object.keys(COMMANDS), 'sleep', 'api'].join(', ');
      throw new Error(`${file}: step ${index + 1}: unknown step "${name}" (${known})`);
    }
    const starts = name === 'record' && step.record?.action === 'start';
    if (name === 'record' && !starts && bodyFromStep(name, step.record).action !== 'stop') {
      throw new Error(`${file}: step ${index + 1}: record is {"action": "start", "name": ...} or "stop"`);
    }
    if (name === 'capture' || name === 'shot' || name === 'frames' || starts) {
      const captureName = step[name]?.name;
      if (typeof captureName !== 'string' || !/^[\w.-]+$/.test(captureName)) {
        throw new Error(`${file}: step ${index + 1}: ${name} needs "name" (letters, digits, . _ -), `
          + 'it becomes the file name');
      }
      if (names.has(captureName)) {
        throw new Error(`${file}: step ${index + 1}: duplicate capture name "${captureName}"`);
      }
      names.add(captureName);
    }
  });
  return { name: scene.name || path.basename(file, '.json'), steps };
}

function captureFile(name, body) {
  if (name === 'capture' || name === 'shot') return `${body.name}.png`;
  if (body.format === 'gif') return `${body.name}.gif`;
  return body.format === 'png-sequence' ? body.name : `${body.name}.png`;
}

async function runStep(context, step, outDir, server) {
  const [name] = Object.keys(step);
  const value = step[name];
  if (name === 'sleep') {
    await sleep(Number(value));
    return {};
  }
  if (name === 'api') {
    return { result: await context.call((value.method || 'POST').toUpperCase(), value.path, value.body) };
  }
  const body = bodyFromStep(name, value);
  if (name === 'connect') {
    if (server) body.server = server;
    else if (body.server === '$server') throw new Error('this scene connects to "$server": pass --server <name>');
  }
  if (name === 'record') {
    // <name>.wav, the waveform <name>.png (which "scene compare" pairs up) and with video <name>.mp4
    if (body.action === 'start') {
      const { name: recordName, ...rest } = body;
      return { result: await context.run(name, { ...rest, out: path.join(outDir, `${recordName}.wav`) }) };
    }
    const { file, image, video, frames, ...details } = await context.run(name, body);
    const local = full => (full ? path.basename(full) : undefined);
    return { capture: { name: path.basename(file, '.wav'), file: local(image), audio: local(file),
      video: local(video), ...details } };
  }
  if (name === 'capture' || name === 'shot' || name === 'frames') {
    const file = captureFile(name, body);
    const { name: captureName, ...rest } = body;
    const result = await context.run(name, { ...rest, out: path.join(outDir, file) });
    const { file: _, ...details } = result;
    return { capture: { name: captureName, file, ...details } };
  }
  return { result: await context.run(name, body, { baseDir: outDir }) };
}

async function run(config, argv) {
  const { flags, positionals } = splitArgs(argv);
  const [file] = positionals;
  if (!file || typeof flags.out !== 'string') {
    throw new Error(`usage: ${APP} mc scene run <scene.json> --out <dir> [--server <name>] [--from <step>] `
      + '[--keep-going] [--restart] [--force]');
  }
  const scene = loadScene(file);
  const outDir = path.resolve(flags.out);
  fs.mkdirSync(outDir, { recursive: true });
  // --from N resumes a failed run at step N (numbers as printed, includes expanded): the client is where step N-1
  // left it, and the captures of the earlier steps stay from the previous manifest in --out
  const from = flags.from === undefined ? 1 : Number(flags.from);
  if (!Number.isInteger(from) || from < 1 || from > scene.steps.length) {
    throw new Error(`--from takes a step number 1-${scene.steps.length}`);
  }
  const context = createContext(config, { restart: Boolean(flags.restart), force: Boolean(flags.force) });
  const manifest = {
    tool: `${APP} mc scene run`, scene: scene.name, sceneFile: path.resolve(file), createdAt: new Date().toISOString(),
    server: typeof flags.server === 'string' ? flags.server : null, status: 'ok', captures: [], steps: [],
  };
  // A step before the first connect (settings, resourcepack) may have to start the client: start it with the
  // session that connect needs, or the connect would have to restart it.
  const first = scene.steps.find(step => 'connect' in step);
  if (first) {
    try {
      context.startAuth = resolveServer(config, manifest.server ?? bodyFromStep('connect', first.connect).server).auth;
    } catch {
      // an unknown server is reported by the connect step itself
    }
  }
  if (from > 1) {
    let previous = null;
    try {
      previous = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
    } catch {
      // no earlier run in --out: only the steps from here on are recorded
    }
    if (previous?.sceneFile === manifest.sceneFile) {
      manifest.captures = previous.captures.filter(capture => capture.step < from);
      manifest.steps = previous.steps.filter(entry => entry.index < from && entry.ok);
    }
    if (!flags.json) console.log(`resuming at step ${from}, ${manifest.captures.length} earlier capture(s) kept`);
  }
  let failed = 0;
  let failedAt = 0;
  for (const [index, step] of scene.steps.entries()) {
    if (index + 1 < from) continue;
    const [name] = Object.keys(step);
    const began = Date.now();
    const entry = { index: index + 1, step };
    try {
      const { capture } = await runStep(context, step, outDir, manifest.server);
      entry.ok = true;
      entry.ms = Date.now() - began;
      if (capture) {
        manifest.captures.push({ ...capture, step: index + 1 });
        const info = capture.audio
          ? `${capture.video ?? capture.audio}  ${capture.durationMs} ms  peak ${capture.peakDb} dB  `
            + `onsets [${capture.onsets.map(onset => onset.ms).join(', ')}]`
          : `${capture.width}x${capture.height}  rect ${rectText(capture.rect)}`
            + (capture.screenTitle ? `  title ${JSON.stringify(capture.screenTitle)}` : '')
            + (capture.hovered?.name ? `  hovered ${JSON.stringify(capture.hovered.name)}` : '')
            + (capture.clipped ? `  CLIPPED ${capture.clipped.join(',')}` : '');
        if (!flags.json) console.log(`ok   ${index + 1} ${name} ${capture.file}  ${info}`);
      } else if (!flags.json) console.log(`ok   ${index + 1} ${name}  ${entry.ms} ms`);
    } catch (error) {
      failed++;
      entry.ok = false;
      entry.ms = Date.now() - began;
      entry.error = error.message;
      console.error(`FAIL ${index + 1} ${name}  ${error.message}`);
      if (!failedAt) {
        failedAt = index + 1;
        // the server's answer to the last command (no permission, unknown command) is usually the cause
        const chat = await lastChatLines(context, 5);
        if (chat.length) console.error(`     chat: ${JSON.stringify(chat)}`);
      }
    }
    manifest.steps.push(entry);
    if (failed && !flags['keep-going']) break;
  }
  manifest.status = failed ? 'failed' : 'ok';
  const skipped = scene.steps.length - manifest.steps.length;
  const manifestFile = path.join(outDir, 'manifest.json');
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  const summary = `${manifest.steps.length} steps, ${failed} failed${skipped ? `, ${skipped} not run` : ''}, `
    + `${manifest.captures.length} captures -> ${manifestFile}`;
  if (flags.json) console.log(JSON.stringify(manifest, null, 2));
  (flags.json ? console.error : console.log)(summary);
  const clipped = manifest.captures.filter(capture => capture.clipped?.length);
  if (clipped.length) {
    console.error(`CLIPPED: ${clipped.map(capture => `${capture.name} (${capture.clipped.join(',')})`).join(', ')}: `
      + 'part of the content is cut off in these pictures');
  }
  if (failedAt) {
    const args = [APP, 'mc scene run', JSON.stringify(path.resolve(file)), '--out', JSON.stringify(outDir),
      ...(manifest.server ? ['--server', manifest.server] : []), '--from', String(failedAt)];
    console.error(`fix the step, then resume where it stopped: ${args.join(' ')}`);
  }
  return failed ? 1 : 0;
}

async function lastChatLines(context, count) {
  try {
    const hud = await context.call('GET', '/hud', { lines: count }, { autoStart: false });
    return (hud.chat?.lines || []).map(plain).filter(Boolean).slice(-count);
  } catch {
    return [];
  }
}

// scene record: every mc action that succeeds while a recording is on is appended to the scene file, so a new
// route is written from steps that worked against the live server instead of from reading code.
export const recordingFile = () => path.join(paths.state, 'scene-recording.json');

export function readRecording() {
  try {
    return JSON.parse(fs.readFileSync(recordingFile(), 'utf8'));
  } catch {
    return null;
  }
}

// read-only lookups and client control never become steps
const NOT_RECORDED = new Set(['screen', 'hud', 'regions', 'texts', 'quit', 'compose']);

/** Called after an mc command succeeded; returns the step number it became, or null. */
export function recordStep(name, body) {
  const recording = readRecording();
  if (!recording || NOT_RECORDED.has(name) || !COMMANDS[name]) return null;
  const value = { ...body };
  if (name === 'capture' || name === 'shot' || name === 'frames') {
    if (typeof value.name !== 'string') {
      if (typeof value.out !== 'string') return null;
      value.name = path.basename(value.out).replace(/\.[^.]+$/, '');
    }
    delete value.out;
  }
  let scene = JSON.parse(fs.readFileSync(recording.file, 'utf8'));
  if (Array.isArray(scene)) scene = { steps: scene };
  scene.steps.push({ [name]: Object.keys(value).length ? value : true });
  fs.writeFileSync(recording.file, `${formatScene(scene)}\n`);
  return scene.steps.length;
}

// one step per line, as the hand-written scenes are
const formatScene = scene => `{${Object.entries(scene).map(([key, value]) => (key === 'steps'
  ? `"steps":[\n${value.map(step => JSON.stringify(step)).join(',\n')}\n]`
  : `${JSON.stringify(key)}:${JSON.stringify(value)}`)).join(',\n')}}`;

function stepCount(file) {
  const scene = JSON.parse(fs.readFileSync(file, 'utf8'));
  return (Array.isArray(scene) ? scene : scene.steps || []).length;
}

function record(argv) {
  const { flags, positionals } = splitArgs(argv);
  const [action, file] = positionals;
  const current = readRecording();
  if (action === 'start') {
    if (!file) throw new Error(`usage: ${APP} mc scene record start <scene.json> [--include <route.json>]`);
    const target = path.resolve(expandHome(file));
    if (current && current.file !== target) throw new Error(`already recording into ${current.file}: stop it first`);
    if (!fs.existsSync(target)) {
      const steps = typeof flags.include === 'string' ? [{ include: flags.include }] : [];
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${formatScene({ name: path.basename(target, '.json'), steps })}\n`);
    }
    const count = stepCount(target);
    fs.mkdirSync(paths.state, { recursive: true });
    fs.writeFileSync(recordingFile(), JSON.stringify({ file: target, startedAt: new Date().toISOString() }));
    console.log(`recording into ${target} (${count} step(s) so far): every mc action that succeeds is appended`);
    return 0;
  }
  if (action === 'stop') {
    if (!current) {
      console.log('not recording');
      return 0;
    }
    fs.rmSync(recordingFile(), { force: true });
    const count = stepCount(current.file);
    console.log(`stopped: ${current.file} has ${count} step(s); replay with ${APP} mc scene run ${current.file} --out <dir>`);
    return 0;
  }
  if (action === 'status' || !action) {
    console.log(current ? `recording into ${current.file} since ${current.startedAt}` : 'not recording');
    return 0;
  }
  throw new Error(`usage: ${APP} mc scene record start <scene.json> [--include <route.json>] | stop | status`);
}

const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function compare(config, argv, services) {
  const { flags } = splitArgs(argv);
  for (const key of ['before', 'after', 'out']) {
    if (typeof flags[key] !== 'string') {
      throw new Error(`usage: ${APP} mc scene compare --before <dir> --after <dir> --out <dir> [--labels A,B] `
        + '[--layout row|column] [--scale N] [--pixel-diff]');
    }
  }
  if (flags['pixel-diff']) {
    // A browser in a one-shot container counts changed pixels; needs Docker, not the client.
    if (!services.webCompare) throw new Error('--pixel-diff needs the web module');
    const args = [ '--before', flags.before, '--after', flags.after, '--out', flags.out, '--diff'];
    for (const key of ['labels', 'layout']) if (typeof flags[key] === 'string') args.push(`--${key}`, flags[key]);
    if (flags.json) args.push('--json');
    return services.webCompare(args);
  }
  const pngs = dir => {
    if (!fs.existsSync(dir)) throw new Error(`${dir} does not exist`);
    return fs.readdirSync(dir).filter(name => name.endsWith('.png') && !/\.(compare|diff)\.png$/.test(name)).sort();
  };
  const before = pngs(flags.before);
  const after = pngs(flags.after);
  const both = before.filter(name => after.includes(name));
  if (!both.length) throw new Error(`no PNG with the same name in ${flags.before} and ${flags.after}`);
  const outDir = path.resolve(flags.out);
  fs.mkdirSync(outDir, { recursive: true });
  const labelText = typeof flags.labels === 'string' ? flags.labels : 'Vorher,Nachher';
  const labels = labelText.split(',').map(label => label.trim());
  const context = createContext(config);
  const pairs = [];
  let failed = 0;
  for (const fileName of both) {
    const name = fileName.slice(0, -4);
    const files = { before: path.resolve(flags.before, fileName), after: path.resolve(flags.after, fileName) };
    const pair = { name, file: `${name}.compare.png`, identical: hash(files.before) === hash(files.after) };
    try {
      const body = { ...files, out: path.join(outDir, pair.file), labels };
      if (typeof flags.layout === 'string') body.layout = flags.layout;
      if (typeof flags.scale === 'string') body.scale = Number(flags.scale);
      const { file: _, ...details } = await context.run('compose', body);
      Object.assign(pair, details);
      if (!flags.json) console.log(`${pair.identical ? 'same   ' : 'changed'}  ${name}  -> ${pair.file}`);
    } catch (error) {
      failed++;
      pair.error = error.message;
      console.error(`FAIL     ${name}  ${error.message}`);
    }
    pairs.push(pair);
  }
  const report = {
    tool: `${APP} mc scene compare`, before: path.resolve(flags.before), after: path.resolve(flags.after), labels,
    createdAt: new Date().toISOString(), pairs,
    onlyBefore: before.filter(name => !after.includes(name)), onlyAfter: after.filter(name => !before.includes(name)),
  };
  const reportFile = path.join(outDir, 'compare.json');
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  if (flags.json) console.log(JSON.stringify(report, null, 2));
  const log = flags.json ? console.error : console.log;
  for (const name of report.onlyBefore) log(`only-before  ${name}`);
  for (const name of report.onlyAfter) log(`only-after   ${name}`);
  const changed = pairs.filter(pair => !pair.error && !pair.identical).length;
  log(`${pairs.length} pairs, ${changed} changed, ${failed} failed -> ${reportFile}`);
  return failed ? 1 : 0;
}

export async function runScene(config, argv, services = {}) {
  const [sub, ...rest] = argv;
  if (sub === 'run') return run(config, rest);
  if (sub === 'compare') return compare(config, rest, services);
  if (sub === 'record') return record(rest);
  throw new Error(`usage: ${APP} mc scene run|record|compare ... (see "${APP} help mc")`);
}

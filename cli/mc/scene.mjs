// mc scene run|compare: replay one JSON scene against two builds and pair up the captures.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { splitArgs } from '../core/args.mjs';
import { APP } from '../core/paths.mjs';
import { COMMANDS, bodyFromStep, createContext } from './api.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const rectText = rect => (rect ? `${rect.x},${rect.y} ${rect.w}x${rect.h}` : '');

function loadScene(file) {
  let scene;
  try {
    scene = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file}: ${error.message}`);
  }
  const steps = Array.isArray(scene) ? scene : scene.steps;
  if (!Array.isArray(steps) || !steps.length) throw new Error(`${file}: expected a list of steps or {"steps": [...]}`);
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
    if (name === 'capture' || name === 'frames' || starts) {
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
  if (name === 'capture') return `${body.name}.png`;
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
  if (name === 'capture' || name === 'frames') {
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
    throw new Error(`usage: ${APP} mc scene run <scene.json> --out <dir> [--server <name>] [--keep-going] `
      + '[--restart] [--force]');
  }
  const scene = loadScene(file);
  const outDir = path.resolve(flags.out);
  fs.mkdirSync(outDir, { recursive: true });
  const context = createContext(config, { restart: Boolean(flags.restart), force: Boolean(flags.force) });
  const manifest = {
    tool: `${APP} mc scene run`, scene: scene.name, sceneFile: path.resolve(file), createdAt: new Date().toISOString(),
    server: typeof flags.server === 'string' ? flags.server : null, status: 'ok', captures: [], steps: [],
  };
  let failed = 0;
  for (const [index, step] of scene.steps.entries()) {
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
          : `${capture.width}x${capture.height}  rect ${rectText(capture.rect)}`;
        if (!flags.json) console.log(`ok   ${index + 1} ${name} ${capture.file}  ${info}`);
      } else if (!flags.json) console.log(`ok   ${index + 1} ${name}  ${entry.ms} ms`);
    } catch (error) {
      failed++;
      entry.ok = false;
      entry.ms = Date.now() - began;
      entry.error = error.message;
      console.error(`FAIL ${index + 1} ${name}  ${error.message}`);
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
  return failed ? 1 : 0;
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
  throw new Error(`usage: ${APP} mc scene run|compare ... (see "${APP} help mc")`);
}

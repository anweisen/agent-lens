// web shot, web measure and web snapshot: one container run over the variants of a spec.
import fs from 'node:fs';
import path from 'node:path';
import { APP } from '../core/paths.mjs';
import { PLAYWRIGHT_VERSION, withContainer } from './docker.mjs';
import { serveStatic } from './serve.mjs';
import { SHOT_OPTIONS, UsageError, boxStr, common, csv, expand, flagOverrides, parse } from './spec.mjs';

const SNAPSHOT_OPTIONS = { ...SHOT_OPTIONS, depth: { type: 'string' }, 'max-chars': { type: 'string' } };

// what went wrong in the page, as a short suffix of a summary line
function problems(s) {
  const parts = [];
  if (s.pageErrors) parts.push(`${s.pageErrors.length} page errors`);
  if (s.consoleErrors) parts.push(`${s.consoleErrors.length} console errors`);
  if (s.failedRequests) parts.push(`${s.failedRequests.length} failed requests`);
  return parts.length ? `(${parts.join(', ')})` : '';
}

function writeMeasure(result, out) {
  const measurements = result.shots.map(({ file, target, ...m }) => m);
  const text = JSON.stringify({ tool: `${APP} web measure`, playwright: PLAYWRIGHT_VERSION, measurements }, null, 2);
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(path.resolve(out), `${text}\n`);
  }
  console.log(text);
  for (const s of result.shots.filter((s) => s.error)) {
    console.error(`FAIL ${s.name} ${s.viewport?.name ?? ''}: ${s.error}`);
  }
}

function printSnapshots(result, json) {
  if (json) {
    const doc = { tool: `${APP} web snapshot`, playwright: PLAYWRIGHT_VERSION, pages: result.shots };
    console.log(JSON.stringify(doc, null, 2));
    return;
  }
  for (const s of result.shots) {
    const browser = s.browser && s.browser !== 'chromium' ? ` ${s.browser}` : '';
    const where = s.selector ? `  ${s.selector}` : '';
    console.log(`== ${s.name} ${s.viewport?.name ?? ''}${browser}  ${s.url}  status ${s.status ?? '-'}${where}`);
    if (s.error) console.log(`FAIL ${s.error}`);
    if (s.snapshot !== undefined) console.log(s.snapshot || '(empty)');
    if (s.truncated) console.log(`... (${s.truncated} more characters, raise --max-chars or use --selector)`);
    for (const [title, key] of [['page errors', 'pageErrors'], ['console errors', 'consoleErrors'],
      ['failed requests', 'failedRequests']]) {
      console.log(`${title}: ${s[key]?.length ?? 0}`);
      for (const line of s[key] ?? []) console.log(`  ${line}`);
    }
  }
}

function writeShots(result, output, outDir, json) {
  const manifestFile = path.join(outDir, 'manifest.json');
  let previous = [];
  try {
    previous = JSON.parse(fs.readFileSync(manifestFile, 'utf8')).shots ?? [];
  } catch {
    // first run into this directory
  }
  output.collect(result.shots.filter((s) => !s.error).map((s) => s.file));
  // A failed shot must not leave an older PNG behind that looks like current evidence.
  for (const s of result.shots) if (s.error) fs.rmSync(path.join(outDir, s.file), { force: true });
  const files = new Set(result.shots.map((s) => s.file));
  const manifest = {
    tool: `${APP} web shot`,
    playwright: PLAYWRIGHT_VERSION,
    createdAt: new Date().toISOString(),
    shots: [...previous.filter((s) => !files.has(s.file)), ...result.shots],
  };
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

  if (json) console.log(JSON.stringify(manifest, null, 2));
  for (const s of result.shots) {
    if (s.error) {
      console.error(`FAIL ${s.file}  ${s.error}`);
      continue;
    }
    if (json) continue;
    const parts = [`ok   ${s.file}`, `${s.image.width}x${s.image.height}px`, s.target];
    if (s.box) parts.push(`box ${boxStr(s.box)}`);
    if (s.clip) parts.push(`clip ${boxStr(s.clip)}`);
    parts.push(`page ${s.page.width}x${s.page.height}`);
    if (s.matches > 1) parts.push(`(${s.matches} matches, first used)`);
    if (!s.networkIdle) parts.push('(network not idle)');
    if (problems(s)) parts.push(problems(s));
    console.log(parts.join('  '));
  }
  const failed = result.shots.filter((s) => s.error).length;
  const summary = `${result.shots.length - failed} shots, ${failed} failed -> ${manifestFile}`;
  if (json) console.error(summary);
  else console.log(summary);
}

// mode: shot | measure | snapshot
export async function runPages(config, mode, argv) {
  const f = parse(argv, mode === 'snapshot' ? SNAPSHOT_OPTIONS : SHOT_OPTIONS);
  let spec = {};
  if (f.spec) {
    try {
      spec = JSON.parse(fs.readFileSync(f.spec, 'utf8'));
    } catch (e) {
      throw new UsageError(`--spec ${f.spec}: ${e.message}`);
    }
  }
  const flags = flagOverrides(f, mode);
  const out = f.out ?? (mode === 'shot' ? spec.out : undefined);
  if (mode === 'shot' && !out) throw new UsageError('shot needs --out <dir> (or "out" in the spec)');
  let served = null;
  if (f.serve) {
    served = await serveStatic(f.serve, f.spa);
    if (!flags.url && !flags.baseUrl) flags.baseUrl = served.baseUrl;
  }
  try {
    const variants = expand(spec, flags, mode, csv(f.only));
    const job = { mode, variants, jobs: Number(f.jobs ?? 4) };
    if (mode === 'snapshot') {
      job.depth = f.depth === undefined ? null : Number(f.depth);
      job.maxChars = Number(f['max-chars'] ?? 6000);
    }
    return await withContainer(config, common(f), async (container) => {
      const outDir = mode === 'shot' ? path.resolve(out) : null;
      const output = outDir ? container.output(outDir) : null;
      const result = await container.run({ ...job, outDir: output?.dir });
      if (mode === 'measure') writeMeasure(result, out);
      else if (mode === 'snapshot') printSnapshots(result, f.json);
      else writeShots(result, output, outDir, f.json);
      return result.shots.some((s) => s.error) ? 1 : 0;
    });
  } finally {
    served?.server.close();
    served?.server.closeAllConnections();
  }
}

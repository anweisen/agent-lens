// web compare: side-by-side composites and pixel diff numbers for PNG pairs of two directories.
import fs from 'node:fs';
import path from 'node:path';
import { APP } from '../core/paths.mjs';
import { withContainer } from './docker.mjs';
import { UsageError, boxStr, common, csv, parse } from './spec.mjs';

export async function compare(config, argv) {
  const f = parse(argv, {
    before: { type: 'string' }, after: { type: 'string' }, out: { type: 'string' }, labels: { type: 'string' },
    layout: { type: 'string' }, threshold: { type: 'string' }, highlight: { type: 'boolean' },
    diff: { type: 'boolean' }, only: { type: 'string', multiple: true }, json: { type: 'boolean' },
  });
  if (!f.before || !f.after || !f.out) throw new UsageError('compare needs --before <dir> --after <dir> --out <dir>');
  const labels = (f.labels ?? 'Vorher,Nachher').split(',').map((s) => s.trim());
  if (labels.length !== 2) throw new UsageError('--labels: expected two comma separated labels');
  const layout = f.layout ?? 'row';
  if (!['row', 'column'].includes(layout)) throw new UsageError('--layout: expected row or column');
  const pngs = (dir) => {
    if (!fs.existsSync(dir)) throw new UsageError(`${dir} does not exist`);
    return fs.readdirSync(dir).filter((n) => n.endsWith('.png') && !/\.(compare|diff)\.png$/.test(n)).sort();
  };
  const only = csv(f.only);
  const wanted = (n) => !only || only.some((o) => n === `${o}.png` || n.startsWith(`${o}.`));
  const before = pngs(f.before).filter(wanted);
  const after = pngs(f.after).filter(wanted);
  const both = before.filter((n) => after.includes(n));
  const onlyBefore = before.filter((n) => !after.includes(n));
  const onlyAfter = after.filter((n) => !before.includes(n));
  if (!both.length) throw new UsageError(`no PNG with the same name in ${f.before} and ${f.after}`);

  return withContainer(config, common(f), async (container) => {
    const outDir = path.resolve(f.out);
    const output = container.output(outDir);
    const result = await container.run({
      mode: 'compare', outDir: output.dir,
      beforeDir: container.input(f.before, both), afterDir: container.input(f.after, both),
      pairs: both.map((n) => ({
        name: n.slice(0, -4), before: n, after: n, scale: Number(/@(\d+(?:\.\d+)?)x/.exec(n)?.[1] ?? 1),
      })),
      labels, layout, threshold: Number(f.threshold ?? 0), highlight: Boolean(f.highlight), diff: Boolean(f.diff),
    });
    output.collect(result.pairs.flatMap((p) => [p.file, p.diffFile]).filter(Boolean));
    const report = {
      tool: `${APP} web compare`, before: path.resolve(f.before), after: path.resolve(f.after), labels,
      createdAt: new Date().toISOString(), pairs: result.pairs, onlyBefore, onlyAfter,
    };
    const reportFile = path.join(outDir, 'compare.json');
    fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
    const failed = result.pairs.filter((p) => p.error);
    if (f.json) console.log(JSON.stringify(report, null, 2));
    for (const p of result.pairs) {
      if (p.error) console.error(`FAIL     ${p.name}  ${p.error}`);
      else if (f.json) continue;
      else if (p.identical) console.log(`same     ${p.name}  0 px  -> ${p.file}`);
      else {
        const dim = (d) => `${d.width}x${d.height}`;
        const size = p.sizeChanged ? `  size ${dim(p.before)} -> ${dim(p.after)}` : '';
        const px = `${p.changedPixels} px (${p.changedPercent}%)`;
        console.log(`changed  ${p.name}  ${px}  bbox ${boxStr(p.bbox)}${size}  -> ${p.file}`);
      }
    }
    const log = f.json ? console.error : console.log;
    for (const n of onlyBefore) log(`only-before  ${n}`);
    for (const n of onlyAfter) log(`only-after   ${n}`);
    const changed = result.pairs.filter((p) => !p.error && !p.identical).length;
    log(`${result.pairs.length} pairs, ${changed} changed, ${failed.length} failed -> ${reportFile}`);
    return failed.length ? 1 : 0;
  });
}
